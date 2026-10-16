import { execFile } from "node:child_process";

/**
 * Sequence syntax (one string per key / dial direction):
 *   plain text        typed as-is (non-ASCII is pasted through the clipboard)
 *   {esc} {enter} {tab} {up} ...         single keys
 *   {shift+tab} {cmd+k} {ctrl+c}         modifier combos
 *   {wait:200}                            pause in ms
 * Example: "/compact{enter}"  "{esc}{esc}"  "{shift+tab}"
 */

export type Step =
	| { kind: "text"; text: string }
	| { kind: "key"; code: number; mods: string[] }
	| { kind: "char"; char: string; mods: string[] }
	| { kind: "wait"; ms: number };

const KEY_CODES: Record<string, number> = {
	esc: 53,
	escape: 53,
	enter: 36,
	return: 36,
	tab: 48,
	space: 49,
	up: 126,
	down: 125,
	left: 123,
	right: 124,
	pageup: 116,
	pagedown: 121,
	home: 115,
	end: 119,
	delete: 51,
	backspace: 51,
};

const MODS: Record<string, string> = {
	shift: "shift down",
	ctrl: "control down",
	control: "control down",
	alt: "option down",
	option: "option down",
	opt: "option down",
	cmd: "command down",
	command: "command down",
};

export function parseSequence(seq: string): Step[] {
	const steps: Step[] = [];
	const re = /\{([^}]+)\}/g;
	let last = 0;
	for (let m = re.exec(seq); m; m = re.exec(seq)) {
		if (m.index > last) steps.push({ kind: "text", text: seq.slice(last, m.index) });
		const tok = m[1].trim().toLowerCase();
		if (tok.startsWith("wait:")) {
			const ms = Number(tok.slice(5));
			if (Number.isFinite(ms) && ms >= 0) steps.push({ kind: "wait", ms: Math.min(ms, 5000) });
		} else {
			const parts = tok.split("+").map((p) => p.trim());
			const key = parts.pop() ?? "";
			const mods = parts.map((p) => MODS[p]);
			if (mods.some((x) => !x)) throw new Error(`unknown modifier: {${m[1]}}`);
			if (key in KEY_CODES) steps.push({ kind: "key", code: KEY_CODES[key], mods });
			else if (key.length === 1) steps.push(mods.length ? { kind: "char", char: key, mods } : { kind: "text", text: key });
			else throw new Error(`unknown key: {${m[1]}}`);
		}
		last = m.index + m[0].length;
	}
	if (last < seq.length) steps.push({ kind: "text", text: seq.slice(last) });
	return steps;
}

export function asString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Builds the AppleScript. `app` empty => send to the frontmost app. */
export function buildAppleScript(app: string, steps: Step[]): string {
	const lines: string[] = [];
	if (app) lines.push(`tell application ${asString(app)} to activate`, "delay 0.08");
	lines.push('tell application "System Events"');
	for (const s of steps) {
		if (s.kind === "wait") lines.push(`delay ${(s.ms / 1000).toFixed(3)}`);
		else if (s.kind === "text") {
			if (isAscii(s.text)) lines.push(`keystroke ${asString(s.text)}`);
			else lines.push(`set the clipboard to ${asString(s.text)}`, 'keystroke "v" using {command down}', "delay 0.05");
		} else {
			const using = s.mods.length ? ` using {${s.mods.join(", ")}}` : "";
			lines.push(s.kind === "char" ? `keystroke ${asString(s.char)}${using}` : `key code ${s.code}${using}`);
		}
	}
	lines.push("end tell");
	return lines.join("\n");
}

export function sendKeys(app: string, sequence: string): Promise<void> {
	const script = buildAppleScript(app.trim(), parseSequence(sequence));
	return new Promise((resolve, reject) => {
		if (process.platform !== "darwin") return reject(new Error("macOS only"));
		execFile("/usr/bin/osascript", ["-e", script], { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
	});
}

export function activateApp(app: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (process.platform !== "darwin" || !app.trim()) return resolve();
		execFile("/usr/bin/open", ["-a", app.trim()], { timeout: 5000 }, (err) => (err ? reject(err) : resolve()));
	});
}
