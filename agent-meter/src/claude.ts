import { join } from "node:path";
import { JsonlTail, listJsonl, safeJson } from "./jsonl.ts";

export interface UsageEvent {
	ts: number;
	input: number;
	output: number;
	cacheCreate: number;
	cacheRead: number;
	model: string;
}

export interface Block {
	start: number;
	end: number;
	lastTs: number;
	tokens: number;
	output: number;
}

export interface ClaudeUsage {
	today: number;
	week: number;
	block: {
		active: boolean;
		tokens: number;
		start: number | null;
		resetsAt: number | null;
		/** tokens per minute over the block so far */
		burnPerMin: number;
		/** 0..100, estimate */
		percent: number | null;
		percentBasis: "limit" | "maxBlock" | "none";
	};
	updatedAt: number;
}

const HOUR = 3_600_000;
const BLOCK_MS = 5 * HOUR;
const RETAIN_MS = 8 * 24 * HOUR;

interface RawLine {
	type?: string;
	timestamp?: string;
	requestId?: string;
	message?: {
		id?: string;
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
}

/** Parses one Claude Code transcript line. Returns [dedupeKey, event] or null. */
export function parseClaudeLine(line: string): [string, UsageEvent] | null {
	const j = safeJson(line) as RawLine | null;
	if (!j || j.type !== "assistant" || !j.message?.usage || !j.timestamp) return null;
	const ts = Date.parse(j.timestamp);
	if (Number.isNaN(ts)) return null;
	const u = j.message.usage;
	const ev: UsageEvent = {
		ts,
		input: u.input_tokens ?? 0,
		output: u.output_tokens ?? 0,
		cacheCreate: u.cache_creation_input_tokens ?? 0,
		cacheRead: u.cache_read_input_tokens ?? 0,
		model: j.message.model ?? "unknown",
	};
	if (ev.model === "<synthetic>") return null;
	const key = `${j.message.id ?? ""}:${j.requestId ?? ""}`;
	return [key === ":" ? `${ts}:${line.length}` : key, ev];
}

export function eventTokens(e: UsageEvent): number {
	return e.input + e.output + e.cacheCreate + e.cacheRead;
}

/** ccusage-style 5h blocks: start floored to the hour; a new block begins after the window or a 5h gap. */
export function buildBlocks(events: UsageEvent[]): Block[] {
	const sorted = [...events].sort((a, b) => a.ts - b.ts);
	const blocks: Block[] = [];
	let cur: Block | null = null;
	for (const e of sorted) {
		if (!cur || e.ts >= cur.end || e.ts - cur.lastTs >= BLOCK_MS) {
			const start = Math.floor(e.ts / HOUR) * HOUR;
			cur = { start, end: start + BLOCK_MS, lastTs: e.ts, tokens: 0, output: 0 };
			blocks.push(cur);
		}
		cur.lastTs = e.ts;
		cur.tokens += eventTokens(e);
		cur.output += e.output;
	}
	return blocks;
}

function startOfLocalDay(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function summarize(events: UsageEvent[], now: number, limit?: number): ClaudeUsage {
	const dayStart = startOfLocalDay(now);
	const weekStart = now - 7 * 24 * HOUR;
	let today = 0;
	let week = 0;
	for (const e of events) {
		const t = eventTokens(e);
		if (e.ts >= dayStart && e.ts <= now) today += t;
		if (e.ts >= weekStart && e.ts <= now) week += t;
	}
	const blocks = buildBlocks(events.filter((e) => e.ts <= now));
	const last = blocks.at(-1);
	const active = !!last && now < last.end && now - last.lastTs < BLOCK_MS;
	const past = active ? blocks.slice(0, -1) : blocks;
	const maxBlock = past.reduce((m, b) => Math.max(m, b.tokens), 0);

	let percent: number | null = null;
	let percentBasis: ClaudeUsage["block"]["percentBasis"] = "none";
	const tokens = active && last ? last.tokens : 0;
	if (limit && limit > 0) {
		percent = Math.min(100, (tokens / limit) * 100);
		percentBasis = "limit";
	} else if (maxBlock > 0) {
		percent = Math.min(100, (tokens / maxBlock) * 100);
		percentBasis = "maxBlock";
	}
	const elapsedMin = active && last ? Math.max(1, (now - last.start) / 60_000) : 1;
	return {
		today,
		week,
		block: {
			active,
			tokens,
			start: active && last ? last.start : null,
			resetsAt: active && last ? last.end : null,
			burnPerMin: active ? Math.round(tokens / elapsedMin) : 0,
			percent: active ? percent : percent === null ? null : 0,
			percentBasis,
		},
		updatedAt: now,
	};
}

/** Incrementally collects usage events from every configured Claude config dir. */
export class ClaudeCollector {
	private tail = new JsonlTail();
	private events = new Map<string, UsageEvent>();

	private dirs: string[];

	constructor(dirs: string[]) {
		this.dirs = dirs;
	}

	scan(now = Date.now()): void {
		const since = now - RETAIN_MS;
		for (const dir of this.dirs) {
			for (const file of listJsonl(join(dir, "projects"), since, this.tail)) {
				for (const line of this.tail.readNew(file)) {
					const r = parseClaudeLine(line);
					if (r && r[1].ts >= since) this.events.set(r[0], r[1]);
				}
			}
		}
		for (const [k, e] of this.events) if (e.ts < since) this.events.delete(k);
	}

	usage(now = Date.now(), limit?: number): ClaudeUsage {
		return summarize([...this.events.values()], now, limit);
	}
}
