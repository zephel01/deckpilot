import { truncate } from "./format.ts";
import type { Reading } from "./model.ts";

/** Key images are 144×144 SVG data URLs (crisp on every Stream Deck model). */

export const COLORS = {
	bg: "#111418",
	fg: "#f2f2f2",
	dim: "#7a828c",
	ok: "#3ecf8e",
	warn: "#f5a524",
	hot: "#f04848",
	off: "#3a3f46",
	allow: "#1f9d55",
	deny: "#c53030",
	always: "#2b6cb0",
	claude: "#d97757",
} as const;

export function levelColor(level: Reading["level"]): string {
	return { ok: COLORS.ok, warn: COLORS.warn, hot: COLORS.hot, off: COLORS.off }[level];
}

export function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function svg(body: string, bg: string = COLORS.bg): string {
	const x = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="18" fill="${bg}"/>${body}</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(x)}`;
}

function text(x: number, y: number, size: number, value: string, color: string = COLORS.fg, weight = 600): string {
	return `<text x="${x}" y="${y}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="middle">${esc(value)}</text>`;
}

export function usageKey(r: Reading): string {
	const color = levelColor(r.level);
	const valueSize = r.value.length > 5 ? 30 : 40;
	let bar = "";
	if (r.percent !== null) {
		const w = Math.round((Math.max(0, Math.min(100, r.percent)) / 100) * 112);
		bar = `<rect x="16" y="98" width="112" height="10" rx="5" fill="${COLORS.off}"/><rect x="16" y="98" width="${w}" height="10" rx="5" fill="${color}"/>`;
	}
	return svg(
		`${text(72, 32, 18, truncate(r.label, 12), COLORS.dim)}${text(72, 78, valueSize, r.value, r.level === "off" ? COLORS.dim : COLORS.fg, 700)}${bar}${text(72, 132, 16, truncate(r.sub, 14), COLORS.dim, 500)}`,
	);
}

export function permissionKey(kind: "allow" | "deny" | "always", pending: { tool: string; summary: string; project: string } | null, count: number): string {
	const titles = { allow: "Allow", deny: "Deny", always: "Always" } as const;
	if (!pending) return svg(`${text(72, 82, 30, titles[kind], COLORS.dim, 700)}`, "#1a1d22");
	const badge = count > 1 ? `<circle cx="124" cy="20" r="14" fill="${COLORS.fg}"/>${text(124, 26, 16, String(count), COLORS.bg, 700)}` : "";
	return svg(
		`${text(72, 40, 30, titles[kind], COLORS.fg, 800)}${text(72, 76, 20, truncate(pending.tool, 12), COLORS.fg)}${text(72, 102, 15, truncate(pending.summary, 16), "#e8e8e8", 500)}${text(72, 128, 14, truncate(pending.project, 16), "#dcdcdc", 500)}${badge}`,
		COLORS[kind],
	);
}

export function sessionKey(counts: { working: number; waiting: number; idle: number }, top: string | null): string {
	const waiting = counts.waiting > 0;
	const bg = waiting ? COLORS.warn : COLORS.bg;
	const fg = waiting ? COLORS.bg : COLORS.fg;
	const head = waiting ? `${counts.waiting} waiting` : counts.working > 0 ? `${counts.working} working` : "idle";
	return svg(
		`${text(72, 34, 18, "Claude Code", waiting ? COLORS.bg : COLORS.claude, 700)}${text(72, 80, 26, head, fg, 800)}${text(72, 110, 15, `W${counts.working} · I${counts.idle}`, waiting ? COLORS.bg : COLORS.dim, 500)}${text(72, 132, 14, truncate(top ?? "", 16), waiting ? COLORS.bg : COLORS.dim, 500)}`,
		bg,
	);
}

export function labelKey(label: string, sub = ""): string {
	return svg(`${text(72, sub ? 72 : 82, label.length > 7 ? 22 : 30, truncate(label, 11), COLORS.fg, 700)}${sub ? text(72, 104, 16, truncate(sub, 14), COLORS.dim, 500) : ""}`);
}
