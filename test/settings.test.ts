import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelLookup,
	parseSettings,
	releaseHostDeadline,
	requireHostDeadline,
	resolveReviewer,
	SettingsError,
} from "../src/settings";

/** Catalogue models reduced to the fields selection reads. */
function model(provider: string, id: string, efforts?: string[]): Model<Api> {
	return { provider, id, thinking: efforts ? { mode: "effort", efforts } : undefined } as unknown as Model<Api>;
}

const sessionModel = model("main", "big", ["low", "medium", "high"]);
const cheap = model("cheap", "fast", ["minimal", "low"]);
const noEffort = model("plain", "m");

function catalogue(currentEffort?: string): ModelLookup {
	const all = [sessionModel, cheap, noEffort];
	return {
		resolve: spec => all.find(m => `${m.provider}/${m.id}` === spec.split(":")[0]),
		list: () => all,
		current: () => sessionModel,
		currentEffort: () => currentEffort,
	};
}

describe("settings parsing", () => {
	test("defaults: 90 s timeout and no rules", () => {
		expect(parseSettings({})).toMatchObject({ timeoutMs: 90_000, rules: [] });
	});

	test("rules may come as an array or as JSON text from the plugin CLI", () => {
		const rules = [{ prefix: ["git", "status"], decision: "allow" }];
		expect(parseSettings({ rules }).rules).toEqual(rules as never);
		expect(parseSettings({ rules: JSON.stringify(rules) }).rules).toEqual(rules as never);
	});

	test.each([
		[{ timeoutMs: 0 }],
		[{ timeoutMs: "soon" }],
		[{ rules: [{ prefix: [], decision: "allow" }] }],
		[{ rules: [{ prefix: ["rm"], decision: "maybe" }] }],
		[{ rules: "not json" }],
		[{ model: 5 }],
	])("rejects invalid values %j", raw => {
		expect(() => parseSettings(raw as Record<string, unknown>)).toThrow(SettingsError);
	});
});

describe("reviewer selection", () => {
	const base = parseSettings({});

	test("unset model falls back to the session model and its current effort", () => {
		const r = resolveReviewer(base, undefined, catalogue("high"));
		expect([r.model.id, r.effort, r.modelSource, r.effortSource]).toEqual(["big", "high", "session-model", "session-model"]);
	});

	test("explicit model with unset effort uses low when supported, else the model default", () => {
		expect(resolveReviewer(parseSettings({ model: "cheap/fast" }), undefined, catalogue()).effort).toBe("low");
		const plain = resolveReviewer(parseSettings({ model: "plain/m" }), undefined, catalogue());
		expect([plain.effort, plain.effortSource]).toEqual([undefined, "model-default"]);
	});

	test("a session selection overrides settings, and null fields inherit", () => {
		const r = resolveReviewer(parseSettings({ model: "cheap/fast" }), { model: "main/big", effort: null }, catalogue());
		expect([r.model.id, r.modelSource, r.effort, r.effortSource]).toEqual(["big", "session", "low", "low-default"]);
		const effortOnly = resolveReviewer(parseSettings({ model: "cheap/fast" }), { model: null, effort: "minimal" }, catalogue());
		expect([effortOnly.model.id, effortOnly.effort, effortOnly.effortSource]).toEqual(["fast", "minimal", "session"]);
	});

	test("an inherited explicit effort the newly selected model lacks is an error", () => {
		const settings = parseSettings({ model: "cheap/fast", effort: "minimal" });
		expect(() => resolveReviewer(settings, { model: "main/big", effort: null }, catalogue())).toThrow(SettingsError);
	});

	test("an unavailable model or unsupported effort is an error, never a substitution", () => {
		expect(() => resolveReviewer(parseSettings({ model: "nope/none" }), undefined, catalogue())).toThrow(/not an available/);
		expect(() => resolveReviewer(parseSettings({ model: "cheap/fast", effort: "high" }), undefined, catalogue())).toThrow(/not supported/);
	});
});

describe("host handler deadline", () => {
	const handle = lookup("extensionHandlers.toolCallTimeoutMs");
	if (!handle) throw new Error("host setting missing");
	const value = (s: Settings) => handle.get(s);

	test("raises only the owning session's Settings and restores it after the last owner", () => {
		const a = Settings.isolated();
		const b = Settings.isolated();
		requireHostDeadline(a, "session-a", 95_000);
		expect(value(a)).toBe(95_000);
		expect(value(b)).toBe(30_000);
		releaseHostDeadline(a, "session-a");
		expect(value(a)).toBe(30_000);
		expect(a.hasRuntimeOverride(handle)).toBe(false);
	});

	test("owners sharing one Settings get the maximum requirement until all have left", () => {
		const shared = Settings.isolated();
		requireHostDeadline(shared, "one", 95_000);
		requireHostDeadline(shared, "two", 185_000);
		expect(value(shared)).toBe(185_000);
		releaseHostDeadline(shared, "two");
		expect(value(shared)).toBe(95_000);
		releaseHostDeadline(shared, "one");
		expect(value(shared)).toBe(30_000);
	});

	test("never lowers a longer configured budget", () => {
		const s = Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": 600_000 });
		requireHostDeadline(s, "x", 95_000);
		expect(value(s)).toBe(600_000);
		releaseHostDeadline(s, "x");
		expect(value(s)).toBe(600_000);
	});

	test("a foreign change after our override is preserved on release", () => {
		const s = Settings.isolated();
		requireHostDeadline(s, "x", 95_000);
		handle.override(s, 400_000);
		releaseHostDeadline(s, "x");
		expect(value(s)).toBe(400_000);
	});

	test("an overlay's inherited override stays inherited after release", () => {
		const parent = Settings.isolated();
		handle.override(parent, 45_000);
		const child = parent.overlay({});
		requireHostDeadline(child, "x", 95_000);
		expect([value(child), value(parent)]).toEqual([95_000, 45_000]);
		releaseHostDeadline(child, "x");
		handle.override(parent, 50_000);
		expect(value(child)).toBe(50_000);
	});

	test("a prior runtime override is restored rather than cleared", () => {
		const s = Settings.isolated();
		handle.override(s, 45_000);
		requireHostDeadline(s, "x", 95_000);
		expect(value(s)).toBe(95_000);
		releaseHostDeadline(s, "x");
		expect(value(s)).toBe(45_000);
		expect(s.hasRuntimeOverride(handle)).toBe(true);
	});
});
