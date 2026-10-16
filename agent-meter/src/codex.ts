import { join } from "node:path";
import { JsonlTail, listJsonl, safeJson } from "./jsonl.ts";

export interface RateWindow {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: number | null;
}

export interface CodexUsage {
	today: number;
	week: number;
	primary: RateWindow | null;
	secondary: RateWindow | null;
	rateLimitsAt: number | null;
	updatedAt: number;
}

interface TokenTotals {
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
}

interface RawWindow {
	used_percent?: number;
	window_minutes?: number;
	resets_in_seconds?: number;
	resets_at?: number;
}

interface RawLine {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		info?: { total_token_usage?: TokenTotals } | null;
		rate_limits?: { primary?: RawWindow | null; secondary?: RawWindow | null } | null;
	};
}

const DAY = 86_400_000;

function totalOf(t: TokenTotals): number {
	return t.total_tokens ?? (t.input_tokens ?? 0) + (t.output_tokens ?? 0);
}

export function toWindow(w: RawWindow | null | undefined, eventTs: number): RateWindow | null {
	if (!w || typeof w.used_percent !== "number") return null;
	let resetsAt: number | null = null;
	if (typeof w.resets_at === "number") resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
	else if (typeof w.resets_in_seconds === "number") resetsAt = eventTs + w.resets_in_seconds * 1000;
	return { usedPercent: w.used_percent, windowMinutes: w.window_minutes ?? null, resetsAt };
}

/** Codex token_count totals are cumulative per rollout file, so usage = positive deltas. */
export class CodexCollector {
	private tail = new JsonlTail();
	private lastTotal = new Map<string, number>();
	private deltas: { ts: number; tokens: number }[] = [];
	private primary: RateWindow | null = null;
	private secondary: RateWindow | null = null;
	private rateAt: number | null = null;

	private codexDir: string;

	constructor(codexDir: string) {
		this.codexDir = codexDir;
	}

	ingest(file: string, line: string): void {
		const j = safeJson(line) as RawLine | null;
		if (!j || j.type !== "event_msg" || j.payload?.type !== "token_count" || !j.timestamp) return;
		const ts = Date.parse(j.timestamp);
		if (Number.isNaN(ts)) return;
		const totals = j.payload.info?.total_token_usage;
		if (totals) {
			const total = totalOf(totals);
			const prev = this.lastTotal.get(file) ?? 0;
			const delta = total >= prev ? total - prev : total;
			this.lastTotal.set(file, total);
			if (delta > 0) this.deltas.push({ ts, tokens: delta });
		}
		const rl = j.payload.rate_limits;
		if (rl && (this.rateAt === null || ts >= this.rateAt)) {
			const p = toWindow(rl.primary, ts);
			const s = toWindow(rl.secondary, ts);
			if (p || s) {
				this.primary = p;
				this.secondary = s;
				this.rateAt = ts;
			}
		}
	}

	scan(now = Date.now()): void {
		const since = now - 8 * DAY;
		for (const file of listJsonl(join(this.codexDir, "sessions"), since, this.tail, "rollout-")) {
			for (const line of this.tail.readNew(file)) this.ingest(file, line);
		}
		this.deltas = this.deltas.filter((d) => d.ts >= since);
	}

	usage(now = Date.now()): CodexUsage {
		const d = new Date(now);
		d.setHours(0, 0, 0, 0);
		const dayStart = d.getTime();
		let today = 0;
		let week = 0;
		for (const x of this.deltas) {
			if (x.ts >= dayStart) today += x.tokens;
			if (x.ts >= now - 7 * DAY) week += x.tokens;
		}
		const expire = (w: RateWindow | null) => (w && w.resetsAt !== null && w.resetsAt < now ? { ...w, usedPercent: 0 } : w);
		return {
			today,
			week,
			primary: expire(this.primary),
			secondary: expire(this.secondary),
			rateLimitsAt: this.rateAt,
			updatedAt: now,
		};
	}
}
