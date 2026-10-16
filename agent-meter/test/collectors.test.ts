import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBlocks, ClaudeCollector, parseClaudeLine, summarize, type UsageEvent } from "../src/claude.ts";
import { CodexCollector, toWindow } from "../src/codex.ts";
import { isLoopbackUrl } from "../src/config.ts";
import { JsonlTail } from "../src/jsonl.ts";
import { llamaStatus, parsePrometheus } from "../src/local.ts";

const H = 3_600_000;

function ev(ts: number, tokens = 100): UsageEvent {
	return { ts, input: tokens, output: 0, cacheCreate: 0, cacheRead: 0, model: "claude-x" };
}

function claudeLine(id: string, ts: string, input: number, output: number): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: ts,
		requestId: `req_${id}`,
		message: { id: `msg_${id}`, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 } },
	});
}

test("parseClaudeLine extracts usage and ignores non-assistant lines", () => {
	const r = parseClaudeLine(claudeLine("a", "2026-10-16T00:00:00Z", 5, 7));
	assert.ok(r);
	assert.equal(r[0], "msg_a:req_a");
	assert.equal(r[1].input + r[1].output + r[1].cacheRead, 22);
	assert.equal(parseClaudeLine(JSON.stringify({ type: "user", timestamp: "2026-10-16T00:00:00Z" })), null);
	assert.equal(parseClaudeLine("not json"), null);
});

test("buildBlocks floors to the hour and splits on 5h window and gaps", () => {
	const t0 = Date.UTC(2026, 9, 16, 1, 30);
	const blocks = buildBlocks([ev(t0), ev(t0 + 2 * H), ev(t0 + 3.6 * H), ev(t0 + 10 * H)]);
	// 01:30, 03:30, 05:06 fall in [01:00, 06:00); 11:30 opens a second block
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].start, Date.UTC(2026, 9, 16, 1, 0));
	assert.equal(blocks[0].tokens, 300);
	assert.equal(blocks[1].start, Date.UTC(2026, 9, 16, 11, 0));
});

test("buildBlocks boundary: event at block end starts a new block", () => {
	const start = Date.UTC(2026, 9, 16, 1, 0);
	const blocks = buildBlocks([ev(start + 10), ev(start + 5 * H)]);
	assert.equal(blocks.length, 2);
});

test("summarize: active block percent vs max past block", () => {
	const now = Date.UTC(2026, 9, 16, 12, 30);
	const events = [ev(now - 24 * H, 1000), ev(now - 20 * 60_000, 250)];
	const u = summarize(events, now);
	assert.equal(u.block.active, true);
	assert.equal(u.block.tokens, 250);
	assert.equal(u.block.percentBasis, "maxBlock");
	assert.equal(u.block.percent, 25);
	assert.equal(u.block.resetsAt, Date.UTC(2026, 9, 16, 17, 0));
	assert.equal(u.week, 1250);
	const withLimit = summarize(events, now, 500);
	assert.equal(withLimit.block.percent, 50);
	assert.equal(withLimit.block.percentBasis, "limit");
});

test("summarize: no active block after the window ends", () => {
	const now = Date.UTC(2026, 9, 16, 12, 0);
	const u = summarize([ev(now - 6 * H)], now);
	assert.equal(u.block.active, false);
	assert.equal(u.block.tokens, 0);
	assert.equal(u.block.resetsAt, null);
});

test("JsonlTail reads only appended complete lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "am-"));
	const f = join(dir, "a.jsonl");
	writeFileSync(f, '{"a":1}\n{"b":');
	const t = new JsonlTail();
	assert.deepEqual(t.readNew(f), ['{"a":1}']);
	appendFileSync(f, '2}\n{"c":3}\n');
	assert.deepEqual(t.readNew(f), ['{"b":2}', '{"c":3}']);
	assert.deepEqual(t.readNew(f), []);
	writeFileSync(f, '{"z":0}\n'); // truncated/replaced
	assert.deepEqual(t.readNew(f), ['{"z":0}']);
});

test("ClaudeCollector dedupes repeated message ids across scans", () => {
	const home = mkdtempSync(join(tmpdir(), "am-claude-"));
	const proj = join(home, "projects", "-Users-x-repo");
	mkdirSync(proj, { recursive: true });
	const now = Date.now();
	const ts = new Date(now - 60_000).toISOString();
	const f = join(proj, "s1.jsonl");
	writeFileSync(f, `${claudeLine("a", ts, 100, 50)}\n${claudeLine("a", ts, 100, 50)}\n`);
	const c = new ClaudeCollector([home]);
	c.scan(now);
	appendFileSync(f, `${claudeLine("b", ts, 1, 1)}\n`);
	c.scan(now);
	const u = c.usage(now);
	assert.equal(u.block.tokens, 160 + 12);
});

test("CodexCollector sums positive deltas and reads rate limits", () => {
	const home = mkdtempSync(join(tmpdir(), "am-codex-"));
	const day = join(home, "sessions", "2026", "10", "16");
	mkdirSync(day, { recursive: true });
	const now = Date.now();
	const iso = (ms: number) => new Date(ms).toISOString();
	const tc = (ms: number, total: number | null, rl?: object) =>
		JSON.stringify({
			timestamp: iso(ms),
			type: "event_msg",
			payload: { type: "token_count", info: total === null ? null : { total_token_usage: { total_tokens: total } }, rate_limits: rl },
		});
	const lines = [
		JSON.stringify({ timestamp: iso(now - 5000), type: "session_meta", payload: { id: "s" } }),
		tc(now - 4000, 1000),
		tc(now - 3000, 1000), // repeated cumulative => 0 delta
		tc(now - 2000, 1500, { primary: { used_percent: 42, window_minutes: 299, resets_in_seconds: 600 }, secondary: { used_percent: 7, resets_at: Math.floor((now + 3600_000) / 1000) } }),
		tc(now - 1000, null),
	];
	writeFileSync(join(day, "rollout-2026-10-16T00-00-00-abc.jsonl"), `${lines.join("\n")}\n`);
	writeFileSync(join(day, "other.jsonl"), `${tc(now - 1000, 99999)}\n`); // ignored: not rollout-*
	const c = new CodexCollector(home);
	c.scan(now);
	const u = c.usage(now);
	assert.equal(u.week, 1500);
	assert.equal(u.primary?.usedPercent, 42);
	assert.equal(u.primary?.resetsAt, now - 2000 + 600_000);
	assert.equal(u.secondary?.usedPercent, 7);
	assert.equal(u.secondary?.resetsAt, Math.floor((now + 3600_000) / 1000) * 1000);
});

test("toWindow zeroes nothing when data missing", () => {
	assert.equal(toWindow(null, 0), null);
	assert.equal(toWindow({}, 0), null);
});

test("prometheus parsing for llama-server metrics", () => {
	const text = [
		"# HELP llamacpp:predicted_tokens_seconds Average generation throughput in tokens/s.",
		"# TYPE llamacpp:predicted_tokens_seconds gauge",
		"llamacpp:predicted_tokens_seconds 33.4448",
		"llamacpp:requests_processing 1",
		'llamacpp_tokens_predicted_total{model="m"} 5678',
	].join("\n");
	assert.equal(parsePrometheus(text).get("llamacpp:requests_processing"), 1);
	const s = llamaStatus("llama", text);
	assert.equal(s.tokPerSec, 33.4448);
	assert.equal(s.processing, 1);
	assert.equal(s.generatedTotal, 5678);
});

test("only loopback URLs are accepted for local endpoints", () => {
	assert.equal(isLoopbackUrl("http://127.0.0.1:8080/metrics"), true);
	assert.equal(isLoopbackUrl("http://localhost:11434/api/ps"), true);
	assert.equal(isLoopbackUrl("http://192.168.1.5:8080/metrics"), false);
	assert.equal(isLoopbackUrl("https://evil.example/metrics"), false);
});
