import { randomUUID } from "node:crypto";
import { basename } from "node:path";

export type SessionState = "working" | "idle" | "needs_input" | "needs_permission";

export interface Session {
	id: string;
	project: string;
	cwd: string;
	state: SessionState;
	updatedAt: number;
}

export interface HookInput {
	hook_event_name?: string;
	session_id?: string;
	cwd?: string;
	notification_type?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	permission_suggestions?: unknown[];
	[k: string]: unknown;
}

const STALE_MS = 6 * 3_600_000;

export class SessionTracker {
	private sessions = new Map<string, Session>();

	handle(input: HookInput, now = Date.now()): void {
		const id = input.session_id;
		if (!id) return;
		const ev = input.hook_event_name;
		if (ev === "SessionEnd") {
			this.sessions.delete(id);
			return;
		}
		const next = nextState(ev, input.notification_type);
		const prev = this.sessions.get(id);
		const cwd = input.cwd ?? prev?.cwd ?? "";
		this.sessions.set(id, {
			id,
			cwd,
			project: cwd ? basename(cwd) : "?",
			state: next ?? prev?.state ?? "idle",
			updatedAt: now,
		});
	}

	setState(id: string | undefined, state: SessionState, now = Date.now()): void {
		if (!id) return;
		const s = this.sessions.get(id);
		if (s) this.sessions.set(id, { ...s, state, updatedAt: now });
	}

	list(now = Date.now()): Session[] {
		for (const [k, s] of this.sessions) if (now - s.updatedAt > STALE_MS) this.sessions.delete(k);
		return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

export function nextState(event: string | undefined, notificationType?: string): SessionState | null {
	switch (event) {
		case "SessionStart":
		case "Stop":
		case "StopFailure":
			return "idle";
		case "UserPromptSubmit":
		case "PreToolUse":
		case "PostToolUse":
		case "SubagentStart":
			return "working";
		case "PermissionRequest":
			return "needs_permission";
		case "Notification":
			if (notificationType === "permission_prompt") return "needs_permission";
			if (notificationType === "idle_prompt" || notificationType === "agent_needs_input" || notificationType === "elicitation_dialog")
				return "needs_input";
			return null;
		default:
			return null;
	}
}

export type Behavior = "allow" | "deny" | "always";

export interface PendingView {
	id: string;
	sessionId: string;
	project: string;
	tool: string;
	summary: string;
	createdAt: number;
	canAlways: boolean;
}

interface Pending extends PendingView {
	input: HookInput;
	resolve: (b: Behavior | null) => void;
	timer: NodeJS.Timeout;
}

export function summarizeTool(tool: string, input: Record<string, unknown> | undefined): string {
	if (!input) return tool;
	const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description;
	const s = typeof v === "string" ? v : "";
	return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** FIFO of PermissionRequest hooks waiting for a deck decision. */
export class PermissionQueue {
	private items: Pending[] = [];

	wait(input: HookInput, waitMs: number, now = Date.now()): { id: string; promise: Promise<Behavior | null> } {
		const id = randomUUID();
		let resolveFn!: (b: Behavior | null) => void;
		const promise = new Promise<Behavior | null>((r) => (resolveFn = r));
		const timer = setTimeout(() => this.settle(id, null), waitMs);
		const cwd = input.cwd ?? "";
		this.items.push({
			id,
			sessionId: input.session_id ?? "",
			project: cwd ? basename(cwd) : "?",
			tool: input.tool_name ?? "?",
			summary: summarizeTool(input.tool_name ?? "", input.tool_input),
			createdAt: now,
			canAlways: Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0,
			input,
			resolve: resolveFn,
			timer,
		});
		return { id, promise };
	}

	/** Resolves the given request, or the oldest one when id is omitted. */
	decide(behavior: Behavior, id?: string): boolean {
		const target = id ? this.items.find((p) => p.id === id) : this.items[0];
		if (!target) return false;
		return this.settle(target.id, behavior);
	}

	/** Drops a request when the hook client disconnects. */
	cancel(id: string): void {
		this.settle(id, null);
	}

	private settle(id: string, b: Behavior | null): boolean {
		const i = this.items.findIndex((p) => p.id === id);
		if (i < 0) return false;
		const [p] = this.items.splice(i, 1);
		clearTimeout(p.timer);
		p.resolve(b);
		return true;
	}

	views(): PendingView[] {
		return this.items.map(({ input: _i, resolve: _r, timer: _t, ...v }) => v);
	}
}

/** Builds the hook stdout for a deck decision. null => no output (normal dialog). */
export function permissionOutput(b: Behavior | null, input: HookInput): Record<string, unknown> | null {
	if (!b) return null;
	if (b === "deny") {
		return {
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "Denied from Stream Deck" },
			},
		};
	}
	const decision: Record<string, unknown> = { behavior: "allow" };
	if (b === "always" && Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0) {
		decision.updatedPermissions = input.permission_suggestions;
	}
	return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}
