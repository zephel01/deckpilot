import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalEndpoint {
	name: string;
	kind: "llama" | "ollama";
	url: string;
}

export interface Config {
	port: number;
	claudeDirs: string[];
	codexDir: string;
	local: LocalEndpoint[];
	/** Seconds the PermissionRequest hook waits for a deck decision before falling back to the terminal dialog. */
	permissionWaitSec: number;
	/** Optional token budget for the Claude 5h block. When unset, % is relative to the largest past block. */
	claudeBlockTokenLimit?: number;
	scanIntervalSec: number;
	localIntervalSec: number;
}

export function meterHome(): string {
	return process.env.AGENT_METER_HOME ?? join(homedir(), ".agent-meter");
}

export function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export const DEFAULT_CONFIG: Config = {
	port: 47823,
	claudeDirs: ["~/.claude"],
	codexDir: "~/.codex",
	local: [{ name: "llama", kind: "llama", url: "http://127.0.0.1:8080/metrics" }],
	permissionWaitSec: 30,
	scanIntervalSec: 15,
	localIntervalSec: 3,
};

export function loadConfig(): Config {
	const file = join(meterHome(), "config.json");
	let user: Partial<Config> = {};
	if (existsSync(file)) {
		user = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
	}
	const cfg: Config = { ...DEFAULT_CONFIG, ...user };
	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (!user.claudeDirs && envDir) cfg.claudeDirs = envDir.split(",");
	cfg.claudeDirs = cfg.claudeDirs.map(expandHome);
	cfg.codexDir = expandHome(process.env.CODEX_HOME ?? cfg.codexDir);
	cfg.local = cfg.local.filter((e) => isLoopbackUrl(e.url));
	return cfg;
}

export function isLoopbackUrl(raw: string): boolean {
	try {
		const u = new URL(raw);
		return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
	} catch {
		return false;
	}
}

/** Returns the shared secret, creating it (mode 0600) on first use. */
export function ensureToken(): string {
	const dir = meterHome();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, "token");
	if (!existsSync(file)) {
		writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
	}
	chmodSync(file, 0o600);
	return readFileSync(file, "utf8").trim();
}

export function readToken(): string | null {
	const file = join(meterHome(), "token");
	return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}
