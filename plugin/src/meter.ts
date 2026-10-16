import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MeterState } from "./model.ts";

const HOME = process.env.AGENT_METER_HOME ?? join(homedir(), ".agent-meter");
const HEADER = "x-agent-meter-token";

function readConn(): { port: number; token: string } | null {
	const tokenFile = join(HOME, "token");
	if (!existsSync(tokenFile)) return null;
	let port = 47823;
	try {
		const cfg = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as { port?: number };
		if (typeof cfg.port === "number") port = cfg.port;
	} catch {
		/* defaults */
	}
	return { port, token: readFileSync(tokenFile, "utf8").trim() };
}

type Listener = (s: MeterState | null) => void;

/** Single poller shared by every visible action. Polls only while someone listens. */
class Meter {
	private listeners = new Set<Listener>();
	private timer: NodeJS.Timeout | null = null;
	private inflight = false;
	state: MeterState | null = null;

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		fn(this.state);
		if (!this.timer) {
			void this.poll();
			this.timer = setInterval(() => void this.poll(), 1000);
		}
		return () => {
			this.listeners.delete(fn);
			if (this.listeners.size === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = null;
			}
		};
	}

	private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response | null> {
		const c = readConn();
		if (!c) return null;
		try {
			return await fetch(`http://127.0.0.1:${c.port}${path}`, {
				method,
				headers: { [HEADER]: c.token, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(2000),
			});
		} catch {
			return null;
		}
	}

	async poll(): Promise<void> {
		if (this.inflight) return;
		this.inflight = true;
		try {
			const res = await this.request("GET", "/v1/state");
			this.state = res?.ok ? ((await res.json()) as MeterState) : null;
		} catch {
			this.state = null;
		} finally {
			this.inflight = false;
		}
		for (const l of this.listeners) l(this.state);
	}

	async decide(behavior: "allow" | "deny" | "always", id?: string): Promise<boolean> {
		const res = await this.request("POST", "/v1/decision", { behavior, id });
		void this.poll();
		return !!res?.ok;
	}

	async refresh(): Promise<void> {
		await this.request("POST", "/v1/refresh");
		await this.poll();
	}
}

export const meter = new Meter();
