/**
 * Plugin settings and reviewer model/effort selection.
 *
 * Settings come from OMP's native plugin configuration (global settings merged
 * with project overrides by the host). Interactive `/auto-review` selections
 * are session overrides layered above them and persisted by `state.ts`.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { DEFAULT_TIMEOUT_MS } from "./policy";

export const PLUGIN_NAME = "omp-automode";

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

function parseRules(value: unknown): ShellRule[] {
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
	const timeout = raw.timeoutMs;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	if (timeout !== undefined && timeout !== null && timeout !== "") {
		const n = typeof timeout === "string" ? Number(timeout) : timeout;
		if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
			throw new SettingsError('setting "timeoutMs" must be a positive number');
		}
		timeoutMs = n;
	}
	return {
		model: optionalString(raw, "model"),
		effort: optionalString(raw, "effort"),
		timeoutMs,
		extraPolicy: optionalString(raw, "extraPolicy"),
		policy: optionalString(raw, "policy"),
		policyTemplate: optionalString(raw, "policyTemplate"),
		rules: parseRules(raw.rules),
	};
}

export async function loadSettings(cwd: string): Promise<AutoReviewSettings> {
	return parseSettings(await getPluginSettings(PLUGIN_NAME, cwd));
}

/** Session override from `/auto-review`; null fields mean "inherit". */
export interface Selection {
	model: string | null;
	effort: string | null;
}

export type SelectionSource = "session" | "settings" | "session-model";

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
	selection: Selection | undefined,
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
