/**
 * Plugin settings and reviewer model/effort selection.
 *
 * Settings come from OMP's native plugin configuration (global settings merged
 * with project overrides by the host). Interactive `/auto-review config`
 * choices are session overrides layered above them and persisted by
 * `state.ts`; `/auto-review save` writes them to the user's plugin settings.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getConfigDirPaths } from "@oh-my-pi/pi-coding-agent/config";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { DEFAULT_TIMEOUT_MS } from "./policy";

const PLUGIN_NAME = "omp-automode";

export interface ShellRule {
	prefix: string[];
	decision: "allow" | "forbidden";
}

export interface AutoReviewSettings {
	model?: string;
	effort?: string;
	timeoutMs: number;
	extraPolicy?: string;
	policy?: string;
	policyTemplate?: string;
	rules: ShellRule[];
}

export class SettingsError extends Error {
	override readonly name = "SettingsError";
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new SettingsError(`setting "${key}" must be a string`);
	return value;
}

export function parseRules(value: unknown): ShellRule[] {
	if (value === undefined || value === null || value === "") return [];
	let list: unknown = value;
	// The plugin CLI stores string values; accept a JSON array encoded in one.
	if (typeof value === "string") {
		try {
			list = JSON.parse(value);
		} catch {
			throw new SettingsError('setting "rules" must be a JSON array');
		}
	}
	if (!Array.isArray(list)) throw new SettingsError('setting "rules" must be an array');
	return list.map((item, index) => {
		if (!item || typeof item !== "object") throw new SettingsError(`rules[${index}] must be an object`);
		const { prefix, decision } = item as Record<string, unknown>;
		if (
			!Array.isArray(prefix) ||
			prefix.length === 0 ||
			!prefix.every(word => typeof word === "string" && word.length > 0)
		) {
			throw new SettingsError(`rules[${index}].prefix must be a non-empty array of non-empty strings`);
		}
		if (decision !== "allow" && decision !== "forbidden") {
			throw new SettingsError(`rules[${index}].decision must be "allow" or "forbidden"`);
		}
		return { prefix: [...prefix] as string[], decision };
	});
}

/** Validate raw plugin settings. Unknown keys are ignored like other OMP plugins. */
export function parseSettings(raw: Record<string, unknown>): AutoReviewSettings {
	return {
		model: optionalString(raw, "model"),
		effort: optionalString(raw, "effort"),
		timeoutMs: parseTimeout(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
		extraPolicy: optionalString(raw, "extraPolicy"),
		policy: optionalString(raw, "policy"),
		policyTemplate: optionalString(raw, "policyTemplate"),
		rules: parseRules(raw.rules),
	};
}

/** A positive finite number of milliseconds; the plugin CLI stores it as text. Unset is undefined. */
export function parseTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
		throw new SettingsError('setting "timeoutMs" must be a positive number');
	}
	return n;
}

export async function loadSettings(cwd: string): Promise<AutoReviewSettings> {
	return parseSettings(await getPluginSettings(PLUGIN_NAME, cwd));
}

/** Raw plugin settings as the host merges them, plus which keys the project overrides. */
export interface SettingsSnapshot {
	raw: Record<string, unknown>;
	projectKeys: ReadonlySet<string>;
	/** The project overrides file the host reads, when one exists. */
	projectPath?: string;
}

/**
 * Read the merged settings and the project layer separately so every value can
 * name its origin. The project file is located like the host's loader does: the
 * first readable `plugin-overrides.json` in the project config directories.
 */
export async function loadSnapshot(cwd: string): Promise<SettingsSnapshot> {
	const raw = await getPluginSettings(PLUGIN_NAME, cwd);
	for (const file of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		let overrides: unknown;
		try {
			overrides = await Bun.file(file).json();
		} catch {
			continue;
		}
		const settings = (overrides as { settings?: Record<string, unknown> } | null)?.settings?.[PLUGIN_NAME];
		const keys = settings && typeof settings === "object" ? Object.keys(settings) : [];
		return { raw, projectKeys: new Set(keys), projectPath: file };
	}
	return { raw, projectKeys: new Set() };
}

export type FileSource = "project settings" | "user settings" | "default";

/** Where a setting's file value comes from; empty values count as unset, as in parsing. */
export function fileSource(snapshot: SettingsSnapshot, key: string): FileSource {
	const value = snapshot.raw[key];
	if (value === undefined || value === null || value === "") return "default";
	return snapshot.projectKeys.has(key) ? "project settings" : "user settings";
}

/**
 * Session overrides from `/auto-review config`; null fields inherit the
 * settings. An empty `rules` array or empty `extraPolicy` is an explicit
 * override, not inheritance.
 */
export interface SessionOverrides {
	model: string | null;
	effort: string | null;
	timeoutMs: number | null;
	rules: ShellRule[] | null;
	extraPolicy: string | null;
}

export const NO_OVERRIDES: SessionOverrides = { model: null, effort: null, timeoutMs: null, rules: null, extraPolicy: null };

const OVERRIDE_KEYS = ["model", "effort", "timeoutMs", "rules", "extraPolicy"] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/** The keys this session overrides, in their canonical order. */
export function overriddenKeys(overrides: SessionOverrides | undefined): OverrideKey[] {
	return overrides ? OVERRIDE_KEYS.filter(key => overrides[key] !== null) : [];
}

export function hasOverrides(overrides: SessionOverrides | undefined): overrides is SessionOverrides {
	return overriddenKeys(overrides).length > 0;
}

/** Settings with the session's timeout, rules and extra policy applied; model and effort resolve in `resolveReviewer`. */
export function applyOverrides(settings: AutoReviewSettings, overrides: SessionOverrides | undefined): AutoReviewSettings {
	if (!overrides) return settings;
	return {
		...settings,
		timeoutMs: overrides.timeoutMs ?? settings.timeoutMs,
		rules: overrides.rules ?? settings.rules,
		extraPolicy: overrides.extraPolicy ?? settings.extraPolicy,
	};
}

/**
 * Write the given overrides to the user's plugin settings, the file
 * `omp plugin config set` writes, in the same text form the CLI stores. An
 * empty extra policy deletes the key. Each key is a separate write: `written`
 * receives every key on disk, also when a later write throws.
 */
export async function saveUserSettings(overrides: Partial<SessionOverrides>, written: OverrideKey[]): Promise<void> {
	const manager = new PluginManager();
	for (const key of OVERRIDE_KEYS) {
		const value = overrides[key];
		if (value === undefined || value === null) continue;
		if (key === "extraPolicy" && value === "") await manager.deletePluginSetting(PLUGIN_NAME, key);
		else await manager.setPluginSetting(PLUGIN_NAME, key, typeof value === "string" ? value : JSON.stringify(value));
		written.push(key);
	}
}

type SelectionSource = "session" | "settings" | "session-model";

export interface EffectiveReviewer {
	model: Model<Api>;
	/** Undefined sends no reasoning option and leaves the model's own default. */
	effort: string | undefined;
	modelSource: SelectionSource;
	effortSource: SelectionSource | "model-default" | "low-default";
}

export interface ModelLookup {
	resolve(spec: string): Model<Api> | undefined;
	list(): Model<Api>[];
	current(): Model<Api> | undefined;
	currentEffort(): string | undefined;
}

/** The host's model catalogue and the session's current model and effort. */
export function modelLookup(ctx: ExtensionContext, pi: ExtensionAPI): ModelLookup {
	return {
		resolve: spec => ctx.models.resolve(spec),
		list: () => ctx.models.list(),
		current: () => ctx.model,
		currentEffort: () => pi.getThinkingLevel(),
	};
}

export function supportedEfforts(model: Model<Api>): readonly string[] {
	return model.thinking?.efforts ?? [];
}

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve the reviewer model and effort. Explicit choices always win and are
 * never substituted: an unavailable model or unsupported effort is an error.
 */
export function resolveReviewer(
	settings: AutoReviewSettings,
	selection: Pick<SessionOverrides, "model" | "effort"> | undefined,
	models: ModelLookup,
): EffectiveReviewer {
	const explicitModel = selection?.model ?? settings.model;
	const modelSource: SelectionSource = selection?.model ? "session" : settings.model ? "settings" : "session-model";
	let model: Model<Api> | undefined;
	if (explicitModel) {
		const found = models.resolve(explicitModel);
		const available = found && models.list().some(m => m.provider === found.provider && m.id === found.id);
		if (!found || !available) {
			throw new SettingsError(`reviewer model "${explicitModel}" is not an available authenticated model`);
		}
		model = found;
	} else {
		model = models.current();
		if (!model) throw new SettingsError("no reviewer model is configured and the session has no model");
	}

	const efforts = supportedEfforts(model);
	const explicitEffort = selection?.effort ?? settings.effort;
	if (explicitEffort) {
		if (!efforts.includes(explicitEffort)) {
			throw new SettingsError(
				`reviewer effort "${explicitEffort}" is not supported by ${modelKey(model)}${
					efforts.length ? ` (supported: ${efforts.join(", ")})` : " (no selectable effort)"
				}`,
			);
		}
		return { model, effort: explicitEffort, modelSource, effortSource: selection?.effort ? "session" : "settings" };
	}
	if (modelSource === "session-model") {
		const current = models.currentEffort();
		if (current && efforts.includes(current)) {
			return { model, effort: current, modelSource, effortSource: "session-model" };
		}
	}
	if (efforts.includes("low")) return { model, effort: "low", modelSource, effortSource: "low-default" };
	return { model, effort: undefined, modelSource, effortSource: "model-default" };
}

// ---------------------------------------------------------------------------
// Host handler deadline: raise the per-handler budget on the calling session's
// own Settings so a full review fits, never lowering it and never persisting.
// ---------------------------------------------------------------------------

const HOST_TIMEOUT_ID = "extensionHandlers.toolCallTimeoutMs";
/** Host default when its setting is unset, nonpositive or not finite. */
const HOST_DEFAULT_TIMEOUT_MS = 30_000;

function getOwn(layer: unknown, segments: readonly string[]): unknown {
	let node = layer;
	for (const segment of segments) {
		if (!node || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

interface DeadlineOwnership {
	owners: Map<string, number>;
	applied?: number;
	prior?: { override: boolean; value: unknown; effective: number };
}

const deadlineOwners = new WeakMap<Settings, DeadlineOwnership>();

function hostTimeoutHandle() {
	const handle = lookup(HOST_TIMEOUT_ID);
	if (!handle) throw new Error(`host setting ${HOST_TIMEOUT_ID} is not registered`);
	return handle;
}

function applyDeadline(settings: Settings, own: DeadlineOwnership): void {
	const handle = hostTimeoutHandle();
	const raw = handle.get(settings);
	const current = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : HOST_DEFAULT_TIMEOUT_MS;
	if (own.applied !== undefined && raw !== own.applied) {
		// Someone else changed it since our override: their value stands.
		own.applied = undefined;
		own.prior = undefined;
	}
	const need = Math.max(0, ...own.owners.values());
	if (own.applied === undefined) {
		if (current >= need) return;
		// Own runtime layer only: an overlay's inherited override must stay inherited.
		const ownOverride = getOwn(settings.overlayLayers().overrides, handle.segments);
		own.prior = { override: ownOverride !== undefined, value: ownOverride, effective: current };
	}
	// Never go below what was in effect before the plugin raised it.
	const value = Math.max(need, own.prior?.effective ?? 0);
	if (value === own.applied) return;
	handle.override(settings, value);
	own.applied = value;
}

/** Register this owner's minimum handler budget on one Settings object and apply the maximum. */
export function requireHostDeadline(settings: Settings, owner: string, ms: number): void {
	let own = deadlineOwners.get(settings);
	if (!own) {
		own = { owners: new Map() };
		deadlineOwners.set(settings, own);
	}
	own.owners.set(owner, ms);
	applyDeadline(settings, own);
}

/** Drop this owner; the last owner restores an unchanged plugin override. */
export function releaseHostDeadline(settings: Settings, owner: string): void {
	const own = deadlineOwners.get(settings);
	if (!own?.owners.delete(owner)) return;
	if (own.owners.size > 0) {
		applyDeadline(settings, own);
		return;
	}
	deadlineOwners.delete(settings);
	const handle = hostTimeoutHandle();
	if (own.applied === undefined || handle.get(settings) !== own.applied) return;
	if (own.prior?.override) handle.override(settings, own.prior.value);
	else handle.clearOverride(settings);
}
