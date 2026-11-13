import { describe, expect, test } from "bun:test";
import { completions, parseSubcommand, renderShow, type ShowView, USAGE } from "../src/commands";
import { applyOverrides, NO_OVERRIDES, parseSettings, type SettingsSnapshot } from "../src/settings";

describe("subcommand parsing", () => {
	test("no argument shows; names are case-insensitive", () => {
		expect(parseSubcommand("")).toBe("show");
		expect(parseSubcommand("  OFF ")).toBe("off");
		expect(parseSubcommand("approve")).toBe("approve");
	});

	test("unknown names and extra words are rejected with the usage, never guessed", () => {
		expect(parseSubcommand("of")).toEqual({ error: USAGE });
		expect(parseSubcommand("off now")).toEqual({ error: USAGE });
	});

	test("completion offers matching subcommands only for the first word", () => {
		expect(completions("o")?.map(c => c.value)).toEqual(["on", "off"]);
		expect(completions("")?.map(c => c.value)).toEqual(["show", "config", "on", "off", "approve", "save", "reload"]);
		expect(completions("x")).toBeNull();
		expect(completions("off ")).toBeNull();
	});
});

describe("show report", () => {
	const snapshot = (raw: Record<string, unknown>, projectKeys: string[] = []): SettingsSnapshot => ({
		raw,
		projectKeys: new Set(projectKeys),
		projectPath: projectKeys.length ? "/p/.omp/plugin-overrides.json" : undefined,
	});
	const view = (snap: SettingsSnapshot, overrides = NO_OVERRIDES, enabled = true): ShowView => ({
		enabled,
		settings: applyOverrides(parseSettings(snap.raw), overrides),
		reviewer: "p/m:low",
		overrides,
		snapshot: snap,
		recentDenials: 0,
	});

	test("each value names its origin: session over project over user over default", () => {
		const snap = snapshot(
			{ timeoutMs: "60000", rules: [{ prefix: ["git", "status"], decision: "allow" }], extraPolicy: "No uploads." },
			["extraPolicy"],
		);
		const text = renderShow(view(snap, { ...NO_OVERRIDES, timeoutMs: 120_000 }));
		expect(text).toContain("Timeout: 120000 ms (from session)");
		expect(text).toContain("Shell rules (from user settings):\n  allow     git status");
		expect(text).toContain("Extra policy (from project settings):\n  No uploads.");
		expect(text).toContain("Policy: built-in");
		expect(text).toContain("Session changes: timeoutMs (not saved");
		expect(text).toContain("Project settings: /p/.omp/plugin-overrides.json");
	});

	test("an empty session rules override hides the settings' rules and says so", () => {
		const snap = snapshot({ rules: [{ prefix: ["rm"], decision: "forbidden" }] });
		const text = renderShow(view(snap, { ...NO_OVERRIDES, rules: [] }));
		expect(text).toContain("Shell rules (from session):\n  (none)");
	});

	test("custom policy text is shown whole", () => {
		const policy = "line one\nline two";
		const text = renderShow(view(snapshot({ policy })));
		expect(text).toContain("Policy: custom (from user settings):\n  line one\n  line two");
	});

	test("off is stated first and plainly", () => {
		expect(renderShow(view(snapshot({}), NO_OVERRIDES, false)).split("\n")[0]).toStartWith("Automatic review: OFF");
	});
});
