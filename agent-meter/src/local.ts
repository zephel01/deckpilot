import type { LocalEndpoint } from "./config.ts";

export interface LocalStatus {
	name: string;
	kind: LocalEndpoint["kind"];
	up: boolean;
	tokPerSec: number | null;
	processing: number | null;
	generatedTotal: number | null;
	promptTotal: number | null;
	models: string[];
	error?: string;
}

/** Minimal Prometheus text parser: first sample per metric name, labels ignored. */
export function parsePrometheus(text: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
		if (!m) continue;
		const v = Number(m[3]);
		if (!out.has(m[1]) && Number.isFinite(v)) out.set(m[1], v);
	}
	return out;
}

function pick(m: Map<string, number>, ...names: string[]): number | null {
	for (const n of names) if (m.has(n)) return m.get(n) ?? null;
	return null;
}

export function llamaStatus(name: string, text: string): LocalStatus {
	const m = parsePrometheus(text);
	return {
		name,
		kind: "llama",
		up: true,
		tokPerSec: pick(m, "llamacpp:predicted_tokens_seconds", "llamacpp_predicted_tokens_seconds"),
		processing: pick(m, "llamacpp:requests_processing", "llamacpp_requests_processing"),
		generatedTotal: pick(m, "llamacpp:tokens_predicted_total", "llamacpp_tokens_predicted_total"),
		promptTotal: pick(m, "llamacpp:prompt_tokens_total", "llamacpp_prompt_tokens_total"),
		models: [],
	};
}

const empty = (e: LocalEndpoint, error: string): LocalStatus => ({
	name: e.name,
	kind: e.kind,
	up: false,
	tokPerSec: null,
	processing: null,
	generatedTotal: null,
	promptTotal: null,
	models: [],
	error,
});

export async function probe(e: LocalEndpoint, timeoutMs = 1500): Promise<LocalStatus> {
	try {
		const res = await fetch(e.url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return empty(e, `HTTP ${res.status}`);
		if (e.kind === "llama") return llamaStatus(e.name, await res.text());
		const j = (await res.json()) as { models?: { name?: string }[] };
		const models = (j.models ?? []).map((x) => x.name ?? "?");
		return { ...empty(e, ""), up: true, error: undefined, models, processing: null };
	} catch (err) {
		return empty(e, err instanceof Error ? err.name : "error");
	}
}
