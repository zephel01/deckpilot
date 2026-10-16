import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, reading, until } from "../src/format.ts";
import { asString, buildAppleScript, parseSequence } from "../src/keys.ts";
import type { MeterState } from "../src/model.ts";
import { esc, permissionKey, usageKey } from "../src/render.ts";

const NOW = Date.UTC(2026, 9, 16, 3, 0);

function state(partial: Partial<MeterState["usage"]> = {}): MeterState {
	return {
		sessions: [],
		pending: [],
		now: NOW,
		usage: { claude: null, codex: null, local: [], ...partial },
	};
}

test("compact and until formatting", () => {
	assert.equal(compact(950), "950");
	assert.equal(compact(1500), "1.5K");
	assert.equal(compact(23_400_000), "23M");
	assert.equal(until(NOW + 133 * 60_000, NOW), "2h13m");
	assert.equal(until(NOW + 26 * 3_600_000, NOW), "1d2h");
	assert.equal(until(null, NOW), "");
});

test("reading: meter offline", () => {
	const r = reading(null, "claude-5h");
	assert.equal(r.level, "off");
	assert.equal(r.sub, "meter offline");
});

test("reading: claude 5h estimate is marked with ~ and colored by level", () => {
	const r = reading(
		state({
			claude: { today: 1, week: 2, block: { active: true, tokens: 2_000_000, resetsAt: NOW + 3_600_000, burnPerMin: 1, percent: 92.4, percentBasis: "maxBlock" } },
		}),
		"claude-5h",
	);
	assert.equal(r.value, "~92%");
	assert.equal(r.level, "hot");
	assert.equal(r.sub, "↻1h00m 2.0M");
});

test("reading: codex windows and local llm", () => {
	const st = state({
		codex: { today: 10, week: 20, primary: { usedPercent: 71, windowMinutes: 300, resetsAt: NOW + 600_000 }, secondary: null },
		local: [{ name: "llama", up: true, tokPerSec: 41.7, processing: 1, models: [] }],
	});
	assert.deepEqual([reading(st, "codex-5h").value, reading(st, "codex-5h").level], ["71%", "warn"]);
	assert.equal(reading(st, "codex-week").level, "off");
	assert.equal(reading(st, "local").value, "42t/s");
	assert.equal(reading(st, "local").sub, "busy ×1");
});

test("parseSequence: text, keys, combos, waits", () => {
	assert.deepEqual(parseSequence("/compact{enter}"), [
		{ kind: "text", text: "/compact" },
		{ kind: "key", code: 36, mods: [] },
	]);
	assert.deepEqual(parseSequence("{shift+tab}{wait:150}{cmd+k}"), [
		{ kind: "key", code: 48, mods: ["shift down"] },
		{ kind: "wait", ms: 150 },
		{ kind: "char", char: "k", mods: ["command down"] },
	]);
	assert.throws(() => parseSequence("{hyper+tab}"), /unknown modifier/);
	assert.throws(() => parseSequence("{f13}"), /unknown key/);
});

test("AppleScript escaping cannot break out of the string literal", () => {
	assert.equal(asString('a"b\\c'), '"a\\"b\\\\c"');
	const script = buildAppleScript('Evil" to do shell script "id', parseSequence('x" & (do shell script "id") & "'));
	// every quote from user input must be escaped
	assert.ok(!/[^\\]" to do shell script/.test(script));
	assert.ok(script.includes('keystroke "x\\" & (do shell script \\"id\\") & \\""'));
});

test("AppleScript: non-ASCII text goes through the clipboard, empty app = frontmost", () => {
	const script = buildAppleScript("", parseSequence("レビューして{enter}"));
	assert.ok(!script.includes("activate"));
	assert.ok(script.includes('set the clipboard to "レビューして"'));
	assert.ok(script.includes('keystroke "v" using {command down}'));
	assert.ok(script.includes("key code 36"));
});

test("SVG renderers escape text and return data URLs", () => {
	assert.equal(esc("<a&b>"), "&lt;a&amp;b&gt;");
	const img = permissionKey("deny", { tool: "Bash", summary: "rm -rf <dir>", project: "repo" }, 2);
	assert.ok(img.startsWith("data:image/svg+xml"));
	assert.ok(decodeURIComponent(img).includes("rm -rf &lt;dir&gt;"));
	assert.ok(decodeURIComponent(usageKey(reading(null, "local"))).includes("--"));
});
