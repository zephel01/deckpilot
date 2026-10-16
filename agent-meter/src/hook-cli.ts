/**
 * Claude Code command hook: forwards the hook input to agent-meter and prints its reply.
 * Always exits 0. If the daemon is down or slow, prints nothing, so Claude Code falls back to its normal flow.
 */
import { loadConfig, readToken } from "./config.ts";
import { TOKEN_HEADER } from "./server.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const body = await readStdin();
	const token = readToken();
	if (!token || !body.trim()) return;
	const cfg = loadConfig();
	let event = "";
	try {
		event = (JSON.parse(body) as { hook_event_name?: string }).hook_event_name ?? "";
	} catch {
		return;
	}
	const timeoutMs = event === "PermissionRequest" ? (cfg.permissionWaitSec + 5) * 1000 : 2000;
	const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/hook`, {
		method: "POST",
		headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
		body,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (res.status !== 200) return;
	const text = await res.text();
	if (text.trim().startsWith("{")) process.stdout.write(text);
}

main()
	.catch(() => {})
	.finally(() => process.exit(0));
