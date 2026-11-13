/**
 * `/auto-review` subcommands: parsing, completion and the `show` report.
 * Dialogs and state changes live in `index.ts`; everything here is pure.
 */
import {
	type AutoReviewSettings,
	type EffectiveReviewer,
	type FileSource,
	fileSource,
	modelKey,
	type OverrideKey,
	OVERRIDE_KEYS,
	type SessionOverrides,
	type SettingsSnapshot,
	type ShellRule,
} from "./settings";

export const SUBCOMMANDS = [
	{ name: "show", description: "Show whether review is on and the effective configuration (default)" },
	{ name: "config", description: "Change this session's reviewer, timeout, rules or extra policy" },
	{ name: "on", description: "Turn automatic review back on for this session" },
	{ name: "off", description: "Turn automatic review off for this session: every call runs unchecked" },
	{ name: "approve", description: "Approve one reviewed retry of a recently denied action" },
	{ name: "save", description: "Save this session's changes to your user plugin settings" },
	{ name: "reload", description: "Re-read the settings files now, refresh the status and deadline, and show the result" },
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number]["name"];

export const USAGE = `Usage: /auto-review [${SUBCOMMANDS.map(s => s.name).join("|")}]`;

/** The subcommand named by the arguments; no argument means `show`. */
export function parseSubcommand(args: string): Subcommand | { error: string } {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "show";
	const match = SUBCOMMANDS.find(s => s.name === words[0]?.toLowerCase());
	if (!match || words.length > 1) return { error: USAGE };
	return match.name;
}

export interface CompletionItem {
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

export type ValueSource = "session" | FileSource;

/** Where the effective value of an overridable key comes from. */
export function valueSource(key: OverrideKey, overrides: SessionOverrides | undefined, snapshot: SettingsSnapshot): ValueSource {
	return overrides && overrides[key] !== null ? "session" : fileSource(snapshot, key);
}

/** Reviewer as `provider/model:effort (model from …, effort from …)`. */
export function describeReviewer(reviewer: EffectiveReviewer, snapshot: SettingsSnapshot): string {
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

export function formatRules(rules: readonly ShellRule[]): string[] {
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
	const changed = OVERRIDE_KEYS.filter(key => view.overrides && view.overrides[key] !== null);
	lines.push(
		changed.length
			? `Session changes: ${changed.join(", ")} (not saved; /auto-review save keeps them)`
			: "Session changes: none",
	);
	lines.push(`Recent denials: ${view.recentDenials}${view.recentDenials ? " (/auto-review approve)" : ""}`);
	if (view.snapshot.projectPath) lines.push(`Project settings: ${view.snapshot.projectPath}`);
	return lines.join("\n");
}
