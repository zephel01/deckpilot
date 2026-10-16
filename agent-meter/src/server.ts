import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClaudeUsage } from "./claude.ts";
import type { CodexUsage } from "./codex.ts";
import type { LocalStatus } from "./local.ts";
import { type Behavior, type HookInput, PermissionQueue, permissionOutput, SessionTracker } from "./state.ts";

export interface UsageSnapshot {
	claude: ClaudeUsage | null;
	codex: CodexUsage | null;
	local: LocalStatus[];
}

export interface AppDeps {
	token: string;
	waitMs: number;
	queue: PermissionQueue;
	tracker: SessionTracker;
	snapshot: () => UsageSnapshot;
	refresh: () => Promise<void>;
}

const MAX_BODY = 1_000_000;
export const TOKEN_HEADER = "x-agent-meter-token";

function sameToken(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function hostAllowed(host: string | undefined, port: number | undefined): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status, { "content-length": "0" });
		res.end();
		return;
	}
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

const BEHAVIORS: Behavior[] = ["allow", "deny", "always"];

export function createApp(deps: AppDeps): Server {
	return createServer(async (req, res) => {
		if (!hostAllowed(req.headers.host, req.socket.localPort)) return send(res, 421, { error: "host" });
		const tok = req.headers[TOKEN_HEADER];
		if (typeof tok !== "string" || !sameToken(tok, deps.token)) return send(res, 401, { error: "token" });

		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			if (req.method === "GET" && url.pathname === "/v1/state") {
				return send(res, 200, {
					sessions: deps.tracker.list(),
					pending: deps.queue.views(),
					usage: deps.snapshot(),
					now: Date.now(),
				});
			}
			if (req.method === "POST" && url.pathname === "/v1/hook") {
				const input = (await readBody(req)) as HookInput;
				deps.tracker.handle(input);
				if (input.hook_event_name !== "PermissionRequest") return send(res, 204);
				const { id, promise } = deps.queue.wait(input, deps.waitMs);
				res.on("close", () => {
					if (!res.writableEnded) deps.queue.cancel(id);
				});
				const behavior = await promise;
				if (res.destroyed) return;
				deps.tracker.setState(input.session_id, behavior ? "working" : "needs_permission");
				const out = permissionOutput(behavior, input);
				return out ? send(res, 200, out) : send(res, 204);
			}
			if (req.method === "POST" && url.pathname === "/v1/decision") {
				const body = (await readBody(req)) as { behavior?: string; id?: string };
				if (!BEHAVIORS.includes(body.behavior as Behavior)) return send(res, 400, { error: "behavior" });
				const ok = deps.queue.decide(body.behavior as Behavior, body.id);
				return send(res, ok ? 200 : 404, { ok });
			}
			if (req.method === "POST" && url.pathname === "/v1/refresh") {
				await deps.refresh();
				return send(res, 200, { ok: true });
			}
			return send(res, 404, { error: "not found" });
		} catch {
			if (!res.headersSent) send(res, 400, { error: "bad request" });
		}
	});
}
