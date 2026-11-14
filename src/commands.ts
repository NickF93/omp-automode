/**
 * `/auto-review` and `/approve`: subcommand parsing, completion, the `show`
 * report and the dialogs that change this session's review state.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { OFF_WARNING } from "./policy";
import {
	applyOverrides,
	type AutoReviewSettings,
	type EffectiveReviewer,
	type FileSource,
	fileSource,
	loadSnapshot,
	modelKey,
	modelLookup,
	NO_OVERRIDES,
	type OverrideKey,
	overriddenKeys,
	parseRules,
	parseSettings,
	parseTimeout,
	resolveReviewer,
	saveUserSettings,
	type SessionOverrides,
	type SettingsSnapshot,
	type ShellRule,
	supportedEfforts,
} from "./settings";
import { canonicalJson, type Control, type SessionState } from "./state";

const SUBCOMMANDS = [
	{ name: "show", description: "Show whether review is on and the effective configuration (default)" },
	{ name: "config", description: "Change this session's reviewer, timeout, rules or extra policy" },
	{ name: "on", description: "Turn automatic review back on for this session" },
	{ name: "off", description: "Turn automatic review off for this session: every call runs unchecked" },
	{ name: "approve", description: "Approve one reviewed retry of a recently denied action" },
	{ name: "save", description: "Save this session's changes to your user plugin settings" },
	{ name: "reload", description: "Re-read the settings files now, refresh the status and deadline, and show the result" },
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number]["name"];

export const USAGE = `Usage: /auto-review [${SUBCOMMANDS.map(s => s.name).join("|")}]`;

/** The subcommand named by the arguments; no argument means `show`. */
export function parseSubcommand(args: string): Subcommand | { error: string } {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "show";
	const match = SUBCOMMANDS.find(s => s.name === words[0]?.toLowerCase());
	if (!match || words.length > 1) return { error: USAGE };
	return match.name;
}

interface CompletionItem {
	value: string;
	label: string;
	description: string;
}

export function completions(prefix: string): CompletionItem[] | null {
	if (prefix.includes(" ")) return null;
	const typed = prefix.trim().toLowerCase();
	const items = SUBCOMMANDS.filter(s => s.name.startsWith(typed)).map(s => ({
		value: s.name,
		label: s.name,
		description: s.description,
	}));
	return items.length ? items : null;
}

/** Where the effective value of an overridable key comes from. */
function valueSource(key: OverrideKey, overrides: SessionOverrides | undefined, snapshot: SettingsSnapshot): "session" | FileSource {
	return overrides && overrides[key] !== null ? "session" : fileSource(snapshot, key);
}

/** Reviewer as `provider/model:effort (model from …, effort from …)`. */
function describeReviewer(reviewer: EffectiveReviewer, snapshot: SettingsSnapshot): string {
	const model =
		reviewer.modelSource === "session"
			? "session"
			: reviewer.modelSource === "settings"
				? fileSource(snapshot, "model")
				: "session model";
	const effort =
		reviewer.effortSource === "session"
			? "session"
			: reviewer.effortSource === "settings"
				? fileSource(snapshot, "effort")
				: reviewer.effortSource === "session-model"
					? "session model"
					: reviewer.effortSource === "low-default"
						? "default"
						: "model default";
	return `${modelKey(reviewer.model)}${reviewer.effort ? `:${reviewer.effort}` : ""} (model from ${model}, effort from ${effort})`;
}

function formatRules(rules: readonly ShellRule[]): string[] {
	if (rules.length === 0) return ["  (none)"];
	return rules.map(rule => `  ${rule.decision === "allow" ? "allow    " : "forbidden"} ${rule.prefix.join(" ")}`);
}

export interface ShowView {
	enabled: boolean;
	/** Effective settings with session overrides applied, or why the settings are invalid. */
	settings: AutoReviewSettings | { error: string };
	reviewer: string;
	overrides: SessionOverrides | undefined;
	snapshot: SettingsSnapshot;
	recentDenials: number;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map(line => `  ${line}`)
		.join("\n");
}

/** The full `/auto-review show` report. Custom policy texts are shown whole. */
export function renderShow(view: ShowView): string {
	const lines: string[] = [];
	const source = (key: OverrideKey) => valueSource(key, view.overrides, view.snapshot);
	lines.push(
		view.enabled
			? "Automatic review: ON"
			: "Automatic review: OFF for this session — every tool call runs without review or rules (/auto-review on)",
	);
	lines.push(`Reviewer: ${view.reviewer}`);
	if ("error" in view.settings) {
		lines.push(`Settings are invalid: ${view.settings.error}`);
	} else {
		const s = view.settings;
		lines.push(`Timeout: ${s.timeoutMs} ms (from ${source("timeoutMs")})`);
		lines.push(`Shell rules (from ${source("rules")}):`, ...formatRules(s.rules));
		lines.push(
			s.extraPolicy ? `Extra policy (from ${source("extraPolicy")}):\n${indent(s.extraPolicy)}` : "Extra policy: (none)",
		);
		lines.push(
			s.policy ? `Policy: custom (from ${fileSource(view.snapshot, "policy")}):\n${indent(s.policy)}` : "Policy: built-in",
		);
		lines.push(
			s.policyTemplate
				? `Policy template: custom (from ${fileSource(view.snapshot, "policyTemplate")}):\n${indent(s.policyTemplate)}`
				: "Policy template: built-in",
		);
	}
	const changed = overriddenKeys(view.overrides);
	lines.push(
		changed.length
			? `Session changes: ${changed.join(", ")} (not saved; /auto-review save keeps them)`
			: "Session changes: none",
	);
	lines.push(`Recent denials: ${view.recentDenials}${view.recentDenials ? " (/auto-review approve)" : ""}`);
	if (view.snapshot.projectPath) lines.push(`Project settings: ${view.snapshot.projectPath}`);
	return lines.join("\n");
}

async function readSnapshot(ctx: ExtensionContext): Promise<SettingsSnapshot | undefined> {
	try {
		return await loadSnapshot(ctx.cwd);
	} catch (error) {
		ctx.ui.notify(`Could not read omp-automode settings: ${(error as Error).message}`, "error");
		return undefined;
	}
}

/** What the dialogs need from the session wiring. */
interface CommandDeps {
	/** This session's own state, which the dialogs change. */
	state: SessionState;
	/** The effective switch and overrides `show` reports: a subagent follows its parent's. */
	control: (ctx: ExtensionContext) => Control;
	/** Re-apply the host deadline, then the status line. */
	refresh: (ctx: ExtensionContext) => Promise<void>;
	showStatus: (ctx: ExtensionContext) => Promise<void>;
}

export function registerCommands(pi: ExtensionAPI, { state, control, refresh, showStatus }: CommandDeps): void {
	async function approveCommand(ctx: ExtensionCommandContext): Promise<void> {
		const denials = state.recentDenials();
		if (denials.length === 0) {
			ctx.ui.notify("No recent automatic review denials on this branch.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/approve needs an interactive selector.", "error");
			return;
		}
		const labels = denials.map(
			(d, i) =>
				`${i + 1}. ${d.action.tool} ${canonicalJson(d.action.input).slice(0, 160)} (cwd ${d.action.cwd}) — ${d.verdict.risk_level} risk: ${d.verdict.rationale}`,
		);
		const choice = await ctx.ui.select("Approve one reviewed retry of exactly this denied action", labels);
		if (choice === undefined) return;
		const denial = denials[labels.indexOf(choice)];
		if (!denial) return;
		if (denial.action.session !== ctx.sessionManager.getSessionId()) {
			ctx.ui.notify("That denial belongs to another session; nothing was approved.", "warning");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Approve one reviewed retry of this exact action?",
			`Risk ${denial.verdict.risk_level}, authorization ${denial.verdict.user_authorization}: ${denial.verdict.rationale}\n\n${JSON.stringify({ tool: denial.action.tool, input: denial.action.input, cwd: denial.action.cwd }, null, 2)}\n\nThe retry is reviewed again with your approval as context. Any change to the action needs a normal review.`,
		);
		if (!confirmed) return;
		state.grant(denial, ctx.sessionManager.getLeafId());
		ctx.ui.notify(
			"Approved one retry of exactly that action. It will be reviewed again with your approval as context; a changed action is reviewed normally.",
			"info",
		);
	}

	async function showCommand(ctx: ExtensionCommandContext): Promise<void> {
		const snapshot = await readSnapshot(ctx);
		if (!snapshot) return;
		const { enabled, overrides } = control(ctx);
		let settings: AutoReviewSettings | { error: string };
		let reviewer: string;
		try {
			const base = parseSettings(snapshot.raw);
			settings = applyOverrides(base, overrides);
			try {
				reviewer = describeReviewer(resolveReviewer(base, overrides, modelLookup(ctx, pi)), snapshot);
			} catch (error) {
				reviewer = `unavailable: ${(error as Error).message}`;
			}
		} catch (error) {
			settings = { error: (error as Error).message };
			reviewer = "unavailable: the settings are invalid";
		}
		ctx.ui.notify(
			renderShow({ enabled, settings, reviewer, overrides, snapshot, recentDenials: state.recentDenials().length }),
			enabled ? "info" : "warning",
		);
	}

	async function configCommand(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/auto-review config needs interactive dialogs; use omp plugin config set @nickf93/omp-automode <key> <value>.", "error");
			return;
		}
		const snapshot = await readSnapshot(ctx);
		if (!snapshot) return;
		let base: AutoReviewSettings;
		try {
			base = parseSettings(snapshot.raw);
		} catch (error) {
			ctx.ui.notify(`omp-automode settings are invalid: ${(error as Error).message}`, "error");
			return;
		}
		const lookupModels = modelLookup(ctx, pi);
		const effective = applyOverrides(base, state.overrides);
		const from = (key: OverrideKey) => valueSource(key, state.overrides, snapshot);
		let current: EffectiveReviewer | undefined;
		let reviewerText: string;
		try {
			current = resolveReviewer(base, state.overrides, lookupModels);
			reviewerText = describeReviewer(current, snapshot);
		} catch (error) {
			reviewerText = `unavailable: ${(error as Error).message}`;
		}
		const options: { key: OverrideKey | "reset"; label: string }[] = [
			{
				key: "model",
				label: `Reviewer model: ${current ? modelKey(current.model) : "unavailable"} (from ${current?.modelSource === "session-model" ? "session model" : from("model")})`,
			},
			{ key: "effort", label: `Reviewer effort: ${current?.effort ?? "model default"}` },
			{ key: "timeoutMs", label: `Timeout: ${effective.timeoutMs} ms (from ${from("timeoutMs")})` },
			{ key: "rules", label: `Shell rules: ${effective.rules.length} (from ${from("rules")})` },
			{ key: "extraPolicy", label: `Extra policy: ${effective.extraPolicy ? "set" : "none"} (from ${from("extraPolicy")})` },
			{ key: "reset", label: "Clear this session's changes" },
		];
		const picked = await ctx.ui.select(
			`Automatic review for this session: ${reviewerText}`,
			options.map(o => o.label),
		);
		const key = options.find(o => o.label === picked)?.key;
		if (!key) return;
		const next: SessionOverrides = { ...(key === "reset" ? NO_OVERRIDES : (state.overrides ?? NO_OVERRIDES)) };
		switch (key) {
			case "reset":
				break;
			case "model": {
				const inherit = "Inherit (settings, else the session model)";
				const choice = await ctx.ui.select("Reviewer model", [inherit, ...lookupModels.list().map(modelKey)]);
				if (choice === undefined) return;
				next.model = choice === inherit || choice === base.model ? null : choice;
				break;
			}
			case "effort": {
				if (!current) {
					ctx.ui.notify("Choose an available reviewer model first.", "warning");
					return;
				}
				const inherit = "Inherit (settings, else default)";
				const choice = await ctx.ui.select(`Reviewer effort for ${modelKey(current.model)}`, [
					inherit,
					...supportedEfforts(current.model),
				]);
				if (choice === undefined) return;
				next.effort = choice === inherit || choice === base.effort ? null : choice;
				break;
			}
			case "timeoutMs": {
				const text = await ctx.ui.input(
					`Review timeout in milliseconds (now ${effective.timeoutMs}; empty uses the settings: ${base.timeoutMs})`,
					String(effective.timeoutMs),
				);
				if (text === undefined) return;
				try {
					const ms = parseTimeout(text.trim());
					next.timeoutMs = ms === undefined || ms === base.timeoutMs ? null : ms;
				} catch (error) {
					ctx.ui.notify(`Not changed: ${(error as Error).message}`, "error");
					return;
				}
				break;
			}
			case "rules": {
				const text = await ctx.ui.editor(
					'Shell rules: a JSON array of {"prefix": ["git", "status"], "decision": "allow" | "forbidden"}. Empty text uses the settings.',
					JSON.stringify(effective.rules, null, 2),
				);
				if (text === undefined) return;
				if (text.trim() === "") {
					next.rules = null;
					break;
				}
				try {
					const rules = parseRules(JSON.parse(text) as unknown);
					next.rules = canonicalJson(rules) === canonicalJson(base.rules) ? null : rules;
				} catch (error) {
					const message = error instanceof SyntaxError ? `not valid JSON (${error.message})` : (error as Error).message;
					ctx.ui.notify(`Not changed: ${message}`, "error");
					return;
				}
				break;
			}
			case "extraPolicy": {
				const text = await ctx.ui.editor(
					"Extra policy, added after the security policy. Clear the text for none.",
					effective.extraPolicy ?? "",
				);
				if (text === undefined) return;
				const trimmed = text.trim();
				next.extraPolicy = trimmed === (base.extraPolicy ?? "").trim() ? null : trimmed;
				break;
			}
		}
		if (key === "model" || key === "effort") {
			try {
				resolveReviewer(base, next, lookupModels);
			} catch (error) {
				ctx.ui.notify(`Not changed: ${(error as Error).message}`, "error");
				return;
			}
		}
		state.setOverrides(next);
		await refresh(ctx);
		const changed = overriddenKeys(state.overrides);
		ctx.ui.notify(
			changed.length
				? `This session now overrides: ${changed.join(", ")}. /auto-review show lists the configuration; /auto-review save keeps the changes.`
				: "This session uses the settings again.",
			"info",
		);
	}

	async function onCommand(ctx: ExtensionCommandContext): Promise<void> {
		if (state.enabled) {
			ctx.ui.notify("Automatic review is already on.", "info");
			return;
		}
		state.setEnabled(true);
		await refresh(ctx);
		ctx.ui.notify("Automatic review is ON for this session.", "info");
	}

	async function offCommand(ctx: ExtensionCommandContext): Promise<void> {
		if (!state.enabled) {
			ctx.ui.notify("Automatic review is already off for this session. /auto-review on turns it back on.", "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/auto-review off needs an interactive confirmation.", "error");
			return;
		}
		// A select, not a confirm: the first, preselected choice keeps review on, so a stray Enter is harmless.
		const keep = "Keep automatic review on";
		const turnOff = "Turn automatic review OFF for this session";
		const choice = await ctx.ui.select(
			"Turn automatic review OFF? Every tool call of this session and its subagents will run without review and without your shell rules, forbidden rules included, until /auto-review on. The choice is kept in the session and restored when you resume it.",
			[keep, turnOff],
		);
		if (choice !== turnOff) return;
		state.setEnabled(false);
		await showStatus(ctx);
		ctx.ui.notify(OFF_WARNING, "warning");
	}

	async function saveCommand(ctx: ExtensionCommandContext): Promise<void> {
		const overrides = state.overrides;
		if (!overrides) {
			ctx.ui.notify("No session changes to save; /auto-review config makes them.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/auto-review save needs an interactive confirmation.", "error");
			return;
		}
		const snapshot = await readSnapshot(ctx);
		if (!snapshot) return;
		const keys = overriddenKeys(overrides);
		// Any project entry overrides the user value in the host's merge, even an empty one.
		const shadowed = keys.filter(key => snapshot.projectKeys.has(key));
		const describe = (key: OverrideKey) =>
			key === "extraPolicy" && !overrides.extraPolicy ? "(none: the setting is removed)" : JSON.stringify(overrides[key]);
		const body = [
			"These values are written to your user plugin settings, the ones `omp plugin config set` writes, and apply to new sessions in every project:",
			"",
			...keys.map(key => `${key}: ${describe(key)}`),
			...(shadowed.length
				? ["", `The project settings (${snapshot.projectPath}) override ${shadowed.join(", ")}; those stay session changes.`]
				: []),
		].join("\n");
		if (!(await ctx.ui.confirm("Save this session's changes?", body))) return;
		const written: OverrideKey[] = [];
		try {
			await saveUserSettings(Object.fromEntries(keys.map(key => [key, overrides[key]])), written);
		} catch (error) {
			ctx.ui.notify(
				`${written.length ? `Saved only ${written.join(", ")}; the rest was not saved` : "Not saved"}: ${(error as Error).message}. The session changes are kept.`,
				"error",
			);
			return;
		}
		state.setOverrides({ ...NO_OVERRIDES, ...Object.fromEntries(shadowed.map(key => [key, overrides[key]])) });
		await showStatus(ctx);
		ctx.ui.notify(
			`Saved ${keys.join(", ")} to your user plugin settings.${
				shadowed.length ? ` ${shadowed.join(", ")} stay session changes because the project settings override them.` : ""
			}`,
			"info",
		);
	}

	async function autoReviewCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const subcommand = parseSubcommand(args);
		if (typeof subcommand !== "string") {
			ctx.ui.notify(subcommand.error, "error");
			return;
		}
		switch (subcommand) {
			case "show":
				return showCommand(ctx);
			case "config":
				return configCommand(ctx);
			case "on":
				return onCommand(ctx);
			case "off":
				return offCommand(ctx);
			case "approve":
				return approveCommand(ctx);
			case "save":
				return saveCommand(ctx);
			case "reload":
				// Reviews already read the settings files on every call; this applies an
				// external edit to the status line and the host deadline now and reports it.
				await refresh(ctx);
				return showCommand(ctx);
		}
	}

	pi.registerCommand("auto-review", {
		description: "Automatic review: show, config, on, off, approve, save",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => autoReviewCommand(args, ctx),
	});

	pi.registerCommand("approve", {
		description: "Alias of /auto-review approve: approve one reviewed retry of a recently denied action",
		handler: async (_args, ctx) => approveCommand(ctx),
	});
}
