import streamDeck, {
	action,
	type Action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { reading } from "./format.ts";
import { activateApp, sendKeys } from "./keys.ts";
import { meter } from "./meter.ts";
import { type MeterState, USAGE_SOURCES, type UsageSource } from "./model.ts";
import { labelKey, permissionKey, sessionKey, usageKey } from "./render.ts";

const UUID = "com.deckpilot";

/** Keeps one meter subscription per visible action instance and re-renders on every poll. */
abstract class LiveAction<T extends Record<string, string | number | boolean | null>> extends SingletonAction<T> {
	private subs = new Map<string, () => void>();
	private settings = new Map<string, T>();
	private last = new Map<string, string>();

	/** True when `payload` differs from what was last sent for this instance (avoids 1 Hz redraws). */
	protected changed(id: string, payload: unknown): boolean {
		const sig = JSON.stringify(payload);
		if (this.last.get(id) === sig) return false;
		this.last.set(id, sig);
		return true;
	}

	protected abstract render(a: Action<T>, s: T, state: MeterState | null): Promise<void> | void;

	protected settingsOf(id: string): T {
		return this.settings.get(id) ?? ({} as T);
	}

	override onWillAppear(ev: WillAppearEvent<T>): void {
		this.settings.set(ev.action.id, ev.payload.settings);
		this.last.delete(ev.action.id);
		this.prepare(ev.action);
		this.subs.get(ev.action.id)?.();
		this.subs.set(
			ev.action.id,
			meter.subscribe((st) => void Promise.resolve(this.render(ev.action, this.settingsOf(ev.action.id), st)).catch(() => {})),
		);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		this.subs.get(ev.action.id)?.();
		this.subs.delete(ev.action.id);
		this.settings.delete(ev.action.id);
		this.last.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
		this.settings.set(ev.action.id, ev.payload.settings);
		void this.render(ev.action, ev.payload.settings, meter.state);
	}

	protected prepare(_a: Action<T>): void {}

	protected async store(a: Action<T>, s: T): Promise<void> {
		this.settings.set(a.id, s);
		await a.setSettings(s);
		await this.render(a, s, meter.state);
	}
}

// ---------------------------------------------------------------- Permission (Allow / Deny / Always)

type PermissionSettings = { behavior: "allow" | "deny" | "always" };

@action({ UUID: `${UUID}.permission` })
class PermissionAction extends LiveAction<PermissionSettings> {
	protected override async render(a: Action<PermissionSettings>, s: PermissionSettings, st: MeterState | null): Promise<void> {
		if (!a.isKey()) return;
		const kind = s.behavior ?? "allow";
		const head = st?.pending[0] ?? null;
		const usable = head && !(kind === "always" && !head.canAlways) ? head : null;
		const img = permissionKey(kind, usable, st?.pending.length ?? 0);
		if (this.changed(a.id, img)) await a.setImage(img);
	}

	override async onKeyDown(ev: KeyDownEvent<PermissionSettings>): Promise<void> {
		const head = meter.state?.pending[0];
		const kind = ev.payload.settings.behavior ?? "allow";
		if (!head || (kind === "always" && !head.canAlways)) return void ev.action.showAlert();
		const ok = await meter.decide(kind, head.id);
		await (ok ? ev.action.showOk() : ev.action.showAlert());
	}
}

// ---------------------------------------------------------------- Session status

type SessionSettings = { app: string };

@action({ UUID: `${UUID}.session` })
class SessionAction extends LiveAction<SessionSettings> {
	protected override async render(a: Action<SessionSettings>, _s: SessionSettings, st: MeterState | null): Promise<void> {
		if (!a.isKey()) return;
		if (!st) {
			const off = labelKey("offline", "agent-meter");
			if (this.changed(a.id, off)) await a.setImage(off);
			return;
		}
		const waiting = st.sessions.filter((x) => x.state === "needs_input" || x.state === "needs_permission");
		const counts = {
			working: st.sessions.filter((x) => x.state === "working").length,
			waiting: Math.max(waiting.length, st.pending.length ? 1 : 0),
			idle: st.sessions.filter((x) => x.state === "idle").length,
		};
		const img = sessionKey(counts, (waiting[0] ?? st.sessions[0])?.project ?? null);
		if (this.changed(a.id, img)) await a.setImage(img);
	}

	override async onKeyDown(ev: KeyDownEvent<SessionSettings>): Promise<void> {
		try {
			await activateApp(ev.payload.settings.app || "Terminal");
		} catch {
			await ev.action.showAlert();
		}
	}
}

// ---------------------------------------------------------------- Usage (key / dial strip / Neo infobar)

type UsageSettings = { source: UsageSource };

function cycle(src: UsageSource | undefined, ticks: number): UsageSource {
	const i = Math.max(0, USAGE_SOURCES.indexOf(src ?? "claude-5h"));
	const n = USAGE_SOURCES.length;
	return USAGE_SOURCES[(((i + ticks) % n) + n) % n];
}

@action({ UUID: `${UUID}.usage` })
class UsageAction extends LiveAction<UsageSettings> {
	protected override prepare(a: Action<UsageSettings>): void {
		if (a.isNeoInfobar()) void a.setFeedbackLayout("layouts/usage-neo.json");
		if (a.isDial()) void a.setTriggerDescription({ rotate: "Switch source", push: "Refresh", touch: "Next source" });
	}

	protected override async render(a: Action<UsageSettings>, s: UsageSettings, st: MeterState | null): Promise<void> {
		const r = reading(st, s.source ?? "claude-5h");
		const feedback = {
			label: r.label,
			value: r.value,
			sub: r.sub,
			bar: { value: r.percent ?? 0, opacity: (r.percent === null ? 0 : 1) as 0 | 1, bar_fill_c: { ok: "#3ecf8e", warn: "#f5a524", hot: "#f04848", off: "#3a3f46" }[r.level] },
		};
		if (!this.changed(a.id, feedback)) return;
		if (a.isKey()) await a.setImage(usageKey(r));
		else if (a.isDial() || a.isNeoInfobar()) await a.setFeedback(feedback);
	}

	private async rotate(a: DialAction<UsageSettings>, s: UsageSettings, ticks: number): Promise<void> {
		await this.store(a, { ...s, source: cycle(s.source, ticks) });
	}

	override onDialRotate(ev: DialRotateEvent<UsageSettings>): Promise<void> {
		return this.rotate(ev.action, this.settingsOf(ev.action.id), ev.payload.ticks);
	}

	override onTouchTap(ev: TouchTapEvent<UsageSettings>): Promise<void> {
		return this.rotate(ev.action, this.settingsOf(ev.action.id), 1);
	}

	override async onDialDown(_ev: DialDownEvent<UsageSettings>): Promise<void> {
		await meter.refresh();
	}

	override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
		await this.store(ev.action, { ...this.settingsOf(ev.action.id), source: cycle(this.settingsOf(ev.action.id).source, 1) });
	}
}

// ---------------------------------------------------------------- Send keys (key)

type KeysSettings = { app: string; sequence: string; label: string };

@action({ UUID: `${UUID}.keys` })
class KeysAction extends SingletonAction<KeysSettings> {
	override async onWillAppear(ev: WillAppearEvent<KeysSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(labelKey(ev.payload.settings.label || ev.payload.settings.sequence || "keys"));
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeysSettings>): Promise<void> {
		if (ev.action.isKey()) await ev.action.setImage(labelKey(ev.payload.settings.label || ev.payload.settings.sequence || "keys"));
	}

	override async onKeyDown(ev: KeyDownEvent<KeysSettings>): Promise<void> {
		const { app = "", sequence = "" } = ev.payload.settings;
		try {
			await sendKeys(app, sequence);
		} catch (e) {
			streamDeck.logger.warn(`sendKeys failed: ${String(e)}`);
			await ev.action.showAlert();
		}
	}
}

// ---------------------------------------------------------------- Dial keys (encoder): left / right / push

type DialKeysSettings = { app: string; left: string; right: string; push: string; label: string };

@action({ UUID: `${UUID}.dialkeys` })
class DialKeysAction extends SingletonAction<DialKeysSettings> {
	private async describe(a: Action<DialKeysSettings>, s: DialKeysSettings): Promise<void> {
		if (!a.isDial()) return;
		await a.setFeedback({ title: s.label || "Keys", value: s.push ? `push: ${s.push}` : "" });
		await a.setTriggerDescription({ rotate: `${s.left || "-"} / ${s.right || "-"}`, push: s.push || "-" });
	}

	override onWillAppear(ev: WillAppearEvent<DialKeysSettings>): Promise<void> {
		return this.describe(ev.action, ev.payload.settings);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialKeysSettings>): Promise<void> {
		return this.describe(ev.action, ev.payload.settings);
	}

	private async run(a: Action<DialKeysSettings>, app: string, seq: string, times = 1): Promise<void> {
		if (!seq) return;
		try {
			await sendKeys(app, seq.repeat(Math.min(Math.max(times, 1), 10)));
		} catch (e) {
			streamDeck.logger.warn(`sendKeys failed: ${String(e)}`);
			if (a.isDial()) await a.showAlert();
		}
	}

	override onDialRotate(ev: DialRotateEvent<DialKeysSettings>): Promise<void> {
		const s = ev.payload.settings;
		const t = ev.payload.ticks;
		return this.run(ev.action, s.app ?? "", t < 0 ? s.left : s.right, Math.abs(t));
	}

	override onDialDown(ev: DialDownEvent<DialKeysSettings>): Promise<void> {
		return this.run(ev.action, ev.payload.settings.app ?? "", ev.payload.settings.push);
	}

	override onTouchTap(ev: TouchTapEvent<DialKeysSettings>): Promise<void> {
		return this.run(ev.action, ev.payload.settings.app ?? "", ev.payload.settings.push);
	}
}

streamDeck.actions.registerAction(new PermissionAction());
streamDeck.actions.registerAction(new SessionAction());
streamDeck.actions.registerAction(new UsageAction());
streamDeck.actions.registerAction(new KeysAction());
streamDeck.actions.registerAction(new DialKeysAction());
await streamDeck.connect();
