import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp, TOKEN_HEADER } from "../src/server.ts";
import { nextState, PermissionQueue, permissionOutput, SessionTracker } from "../src/state.ts";

const TOKEN = "t".repeat(64);
let port = 0;
let base = "";
const queue = new PermissionQueue();
const tracker = new SessionTracker();
let server: ReturnType<typeof createApp>;

before(async () => {
	server = createApp({
		token: TOKEN,
		waitMs: 500,
		queue,
		tracker,
		snapshot: () => ({ claude: null, codex: null, local: [] }),
		refresh: async () => {},
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	port = (server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

const h = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", [TOKEN_HEADER]: TOKEN, ...extra });

const permInput = {
	hook_event_name: "PermissionRequest",
	session_id: "s1",
	cwd: "/Users/h/works/repo",
	tool_name: "Bash",
	tool_input: { command: "npm test" },
	permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }],
};

test("rejects missing or wrong token", async () => {
	assert.equal((await fetch(`${base}/v1/state`)).status, 401);
	assert.equal((await fetch(`${base}/v1/state`, { headers: { [TOKEN_HEADER]: "x" } })).status, 401);
});

test("rejects foreign Host header (DNS rebinding)", async () => {
	const { request } = await import("node:http");
	const status = await new Promise<number>((resolve) => {
		const req = request({ host: "127.0.0.1", port, path: "/v1/state", headers: { host: "evil.example", [TOKEN_HEADER]: TOKEN } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.end();
	});
	assert.equal(status, 421);
});

test("status hooks update sessions and return 204", async () => {
	const r = await fetch(`${base}/v1/hook`, { method: "POST", headers: h(), body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/x/proj" }) });
	assert.equal(r.status, 204);
	const st = (await (await fetch(`${base}/v1/state`, { headers: h() })).json()) as { sessions: { id: string; state: string; project: string }[] };
	const s = st.sessions.find((x) => x.id === "s2");
	assert.equal(s?.state, "working");
	assert.equal(s?.project, "proj");
});

test("PermissionRequest waits for deck decision: allow", async () => {
	const pending = fetch(`${base}/v1/hook`, { method: "POST", headers: h(), body: JSON.stringify(permInput) });
	await new Promise((r) => setTimeout(r, 50));
	const st = (await (await fetch(`${base}/v1/state`, { headers: h() })).json()) as { pending: { tool: string; summary: string; canAlways: boolean }[] };
	assert.equal(st.pending.length, 1);
	assert.equal(st.pending[0].summary, "npm test");
	assert.equal(st.pending[0].canAlways, true);
	const d = await fetch(`${base}/v1/decision`, { method: "POST", headers: h(), body: JSON.stringify({ behavior: "allow" }) });
	assert.equal(d.status, 200);
	const res = await pending;
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
});

test("PermissionRequest: always passes permission_suggestions through", async () => {
	const pending = fetch(`${base}/v1/hook`, { method: "POST", headers: h(), body: JSON.stringify(permInput) });
	await new Promise((r) => setTimeout(r, 50));
	await fetch(`${base}/v1/decision`, { method: "POST", headers: h(), body: JSON.stringify({ behavior: "always" }) });
	const body = (await (await pending).json()) as { hookSpecificOutput: { decision: { updatedPermissions: unknown } } };
	assert.deepEqual(body.hookSpecificOutput.decision.updatedPermissions, permInput.permission_suggestions);
});

test("PermissionRequest: timeout falls back with empty 204", async () => {
	const t = Date.now();
	const res = await fetch(`${base}/v1/hook`, { method: "POST", headers: h(), body: JSON.stringify(permInput) });
	assert.equal(res.status, 204);
	assert.ok(Date.now() - t >= 450);
	assert.equal(queue.views().length, 0);
});

test("decision with nothing pending is 404, bad behavior is 400", async () => {
	assert.equal((await fetch(`${base}/v1/decision`, { method: "POST", headers: h(), body: JSON.stringify({ behavior: "deny" }) })).status, 404);
	assert.equal((await fetch(`${base}/v1/decision`, { method: "POST", headers: h(), body: JSON.stringify({ behavior: "yolo" }) })).status, 400);
});

test("permissionOutput deny shape and null fallback", () => {
	assert.deepEqual(permissionOutput("deny", {}), {
		hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from Stream Deck" } },
	});
	assert.equal(permissionOutput(null, {}), null);
	// always without suggestions degrades to plain allow
	assert.deepEqual(permissionOutput("always", {}), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
});

test("nextState mapping", () => {
	assert.equal(nextState("Stop"), "idle");
	assert.equal(nextState("PreToolUse"), "working");
	assert.equal(nextState("Notification", "permission_prompt"), "needs_permission");
	assert.equal(nextState("Notification", "idle_prompt"), "needs_input");
	assert.equal(nextState("Notification", "auth_success"), null);
});
