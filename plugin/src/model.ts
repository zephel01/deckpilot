/** Shapes returned by agent-meter's GET /v1/state (kept in sync with agent-meter/src). */

export interface Session {
	id: string;
	project: string;
	cwd: string;
	state: "working" | "idle" | "needs_input" | "needs_permission";
	updatedAt: number;
}

export interface Pending {
	id: string;
	sessionId: string;
	project: string;
	tool: string;
	summary: string;
	createdAt: number;
	canAlways: boolean;
}

export interface RateWindow {
	usedPercent: number;
	windowMinutes: number | null;
	resetsAt: number | null;
}

export interface MeterState {
	sessions: Session[];
	pending: Pending[];
	now: number;
	usage: {
		claude: {
			today: number;
			week: number;
			block: {
				active: boolean;
				tokens: number;
				resetsAt: number | null;
				burnPerMin: number;
				percent: number | null;
				percentBasis: "limit" | "maxBlock" | "none";
			};
		} | null;
		codex: {
			today: number;
			week: number;
			primary: RateWindow | null;
			secondary: RateWindow | null;
		} | null;
		local: {
			name: string;
			up: boolean;
			tokPerSec: number | null;
			processing: number | null;
			models: string[];
		}[];
	};
}

export type UsageSource =
	| "claude-5h"
	| "claude-today"
	| "claude-week"
	| "codex-5h"
	| "codex-week"
	| "codex-today"
	| "local";

export const USAGE_SOURCES: UsageSource[] = ["claude-5h", "claude-today", "claude-week", "codex-5h", "codex-week", "codex-today", "local"];

/** What every display surface (key / touch strip / Neo infobar) renders. */
export interface Reading {
	label: string;
	value: string;
	sub: string;
	/** 0..100 or null when there is no meaningful bar */
	percent: number | null;
	level: "ok" | "warn" | "hot" | "off";
}
