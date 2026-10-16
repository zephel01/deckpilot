import { ClaudeCollector } from "./claude.ts";
import { CodexCollector } from "./codex.ts";
import { ensureToken, loadConfig } from "./config.ts";
import { type LocalStatus, probe } from "./local.ts";
import { createApp, type UsageSnapshot } from "./server.ts";
import { PermissionQueue, SessionTracker } from "./state.ts";

const cfg = loadConfig();
const token = ensureToken();
const claude = new ClaudeCollector(cfg.claudeDirs);
const codex = new CodexCollector(cfg.codexDir);
let local: LocalStatus[] = [];

function log(msg: string): void {
	process.stdout.write(`[agent-meter ${new Date().toISOString()}] ${msg}\n`);
}

async function scanFiles(): Promise<void> {
	const t = Date.now();
	try {
		claude.scan();
	} catch (e) {
		log(`claude scan failed: ${String(e)}`);
	}
	try {
		codex.scan();
	} catch (e) {
		log(`codex scan failed: ${String(e)}`);
	}
	const ms = Date.now() - t;
	if (ms > 2000) log(`scan took ${ms}ms`);
}

async function scanLocal(): Promise<void> {
	local = await Promise.all(cfg.local.map((e) => probe(e)));
}

const snapshot = (): UsageSnapshot => ({
	claude: claude.usage(Date.now(), cfg.claudeBlockTokenLimit),
	codex: codex.usage(),
	local,
});

const server = createApp({
	token,
	waitMs: cfg.permissionWaitSec * 1000,
	queue: new PermissionQueue(),
	tracker: new SessionTracker(),
	snapshot,
	refresh: async () => {
		await scanFiles();
		await scanLocal();
	},
});

await scanFiles();
await scanLocal();
setInterval(scanFiles, cfg.scanIntervalSec * 1000).unref();
setInterval(scanLocal, cfg.localIntervalSec * 1000).unref();

server.listen(cfg.port, "127.0.0.1", () => log(`listening on 127.0.0.1:${cfg.port}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		server.close();
		process.exit(0);
	});
}
