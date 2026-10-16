import type { MeterState, Reading, UsageSource } from "./model.ts";

export function compact(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
	return String(Math.round(n));
}

export function until(ts: number | null, now: number): string {
	if (!ts) return "";
	const min = Math.max(0, Math.round((ts - now) / 60_000));
	if (min >= 1440) return `${Math.floor(min / 1440)}d${Math.floor((min % 1440) / 60)}h`;
	if (min >= 60) return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
	return `${min}m`;
}

export function levelOf(pct: number | null): Reading["level"] {
	if (pct === null) return "ok";
	if (pct >= 90) return "hot";
	if (pct >= 70) return "warn";
	return "ok";
}

const OFF = (label: string, sub = "no data"): Reading => ({ label, value: "--", sub, percent: null, level: "off" });

export function reading(state: MeterState | null, source: UsageSource): Reading {
	if (!state) return OFF(labelOf(source), "meter offline");
	const { claude, codex, local } = state.usage;
	const now = state.now;
	switch (source) {
		case "claude-5h": {
			if (!claude) return OFF("Claude 5h");
			const b = claude.block;
			if (!b.active) return { label: "Claude 5h", value: "idle", sub: "no active block", percent: 0, level: "ok" };
			const est = b.percentBasis === "maxBlock" ? "~" : "";
			const value = b.percent === null ? compact(b.tokens) : `${est}${Math.round(b.percent)}%`;
			return { label: "Claude 5h", value, sub: `↻${until(b.resetsAt, now)} ${compact(b.tokens)}`, percent: b.percent, level: levelOf(b.percent) };
		}
		case "claude-today":
			return claude ? { label: "Claude today", value: compact(claude.today), sub: "tokens", percent: null, level: "ok" } : OFF("Claude today");
		case "claude-week":
			return claude ? { label: "Claude 7d", value: compact(claude.week), sub: "tokens", percent: null, level: "ok" } : OFF("Claude 7d");
		case "codex-5h":
		case "codex-week": {
			const label = source === "codex-5h" ? "Codex 5h" : "Codex week";
			const w = source === "codex-5h" ? codex?.primary : codex?.secondary;
			if (!w) return OFF(label);
			return { label, value: `${Math.round(w.usedPercent)}%`, sub: `↻${until(w.resetsAt, now)}`, percent: w.usedPercent, level: levelOf(w.usedPercent) };
		}
		case "codex-today":
			return codex ? { label: "Codex today", value: compact(codex.today), sub: "tokens", percent: null, level: "ok" } : OFF("Codex today");
		case "local": {
			const up = local.find((l) => l.up);
			if (!up) return OFF("Local LLM", local.length ? "down" : "not set");
			const busy = (up.processing ?? 0) > 0;
			return {
				label: up.name,
				value: up.tokPerSec === null ? (up.models[0] ?? "up") : `${up.tokPerSec.toFixed(0)}t/s`,
				sub: busy ? `busy ×${up.processing}` : up.models.length ? `${up.models.length} model(s)` : "idle",
				percent: null,
				level: busy ? "warn" : "ok",
			};
		}
	}
}

export function labelOf(source: UsageSource): string {
	return (
		{
			"claude-5h": "Claude 5h",
			"claude-today": "Claude today",
			"claude-week": "Claude 7d",
			"codex-5h": "Codex 5h",
			"codex-week": "Codex week",
			"codex-today": "Codex today",
			local: "Local LLM",
		} as const
	)[source];
}

export function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
