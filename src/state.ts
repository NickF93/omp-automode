/**
 * Per-session review state: selection, recent denials, one-use grants,
 * circuit breaker, and the persisted replay union.
 *
 * Persisted entries restore only the reviewer selection and recent denials of
 * the active branch. Grants are live, in-memory, one-use claims and are never
 * restored, so a crash or replay cannot resurrect a permission.
 */
import {
	APPROVE_HISTORY,
	BREAKER_CONSECUTIVE_DENIALS,
	BREAKER_WINDOW,
	BREAKER_WINDOW_DENIALS,
} from "./policy";
import type { Selection } from "./settings";

export const ENTRY_TYPE = "omp-automode";
const ENTRY_VERSION = 1;

/** The exact action a review judged. */
export interface ActionKey {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	session: string;
}

export interface Verdict {
	risk_level: "low" | "medium" | "high" | "critical";
	user_authorization: "unknown" | "low" | "medium" | "high";
	outcome: "allow" | "deny";
	rationale: string;
}

export type ResultKind = "verdict" | "timeout" | "cancelled" | "failure" | "input_budget";

export interface ResultEntry {
	v: 1;
	kind: "result";
	id: string;
	runId: string;
	toolCallId: string;
	action: ActionKey;
	model: string | null;
	effort: string | null;
	result: ResultKind;
	verdict?: Verdict;
	detail?: string;
	attempts: number;
	checkpointRestarts: number;
	samplingRequests: number;
	elapsedMs: number;
}

export interface SelectionEntry {
	v: 1;
	kind: "selection";
	model: string | null;
	effort: string | null;
}

export type ApprovalKind = "denial_retry" | "input_budget";

export interface ApprovalEntry {
	v: 1;
	kind: "approval";
	id: string;
	approvalKind: ApprovalKind;
	denialId?: string;
	action: ActionKey;
	branchLeaf: string | null;
	/** How the user answered: always an explicit plugin dialog selection. */
	provenance: "approve_command" | "input_budget_confirm";
}

export interface ConsumedEntry {
	v: 1;
	kind: "consumed";
	approvalId: string;
	toolCallId: string;
	reviewId?: string;
}

/** A plan the user approved in native plan review, recorded at its position on the branch. */
export interface PlanAdoptionEntry {
	v: 1;
	kind: "plan_adoption";
	path: string;
	content: string;
	/** True when `content` is the plan file read at approval, false when only the submitted snapshot was available. */
	fromFile: boolean;
}

export type PersistedEntry = ResultEntry | SelectionEntry | ApprovalEntry | ConsumedEntry | PlanAdoptionEntry;

/** A completed policy denial offered by `/approve`. */
export interface DenialEvent {
	id: string;
	action: ActionKey;
	verdict: Verdict;
}

export interface Grant {
	id: string;
	kind: ApprovalKind;
	denial?: DenialEvent;
	action: ActionKey;
}

/** Stable structural JSON: object keys sorted, so equal actions compare equal. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		}
		return v;
	});
}

export function sameAction(a: ActionKey, b: ActionKey): boolean {
	return a.tool === b.tool && a.cwd === b.cwd && a.session === b.session && canonicalJson(a.input) === canonicalJson(b.input);
}

/** Outcome of recording one reviewed result in the breaker. */
export interface BreakerTrip {
	consecutive: number;
	inWindow: number;
	windowSize: number;
}

/** Denial circuit breaker for one user-driven agent run. */
export class CircuitBreaker {
	#window: boolean[] = [];
	#consecutive = 0;
	#tripped = false;

	reset(): void {
		this.#window = [];
		this.#consecutive = 0;
		this.#tripped = false;
	}

	/** Record a completed review: true for a policy denial, false for every other result. Returns a trip once. */
	record(denied: boolean): BreakerTrip | undefined {
		this.#window.push(denied);
		if (this.#window.length > BREAKER_WINDOW) this.#window.shift();
		this.#consecutive = denied ? this.#consecutive + 1 : 0;
		const inWindow = this.#window.filter(Boolean).length;
		if (this.#tripped) return undefined;
		if (this.#consecutive >= BREAKER_CONSECUTIVE_DENIALS || inWindow >= BREAKER_WINDOW_DENIALS) {
			this.#tripped = true;
			return { consecutive: this.#consecutive, inWindow, windowSize: this.#window.length };
		}
		return undefined;
	}
}

export type AppendEntry = (customType: string, data: PersistedEntry) => void;

/** Branch entry as returned by the session manager; only custom entries matter here. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The package's one structural guard for untyped session and settings data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

const RISKS: readonly unknown[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly unknown[] = ["unknown", "low", "medium", "high"];

function parseVerdict(value: unknown): Verdict | undefined {
	if (!isRecord(value)) return undefined;
	const { risk_level, user_authorization, outcome, rationale } = value;
	if (!RISKS.includes(risk_level) || !AUTHORIZATIONS.includes(user_authorization)) return undefined;
	if ((outcome !== "allow" && outcome !== "deny") || typeof rationale !== "string") return undefined;
	return { risk_level, user_authorization, outcome, rationale } as Verdict;
}

function parseAction(value: unknown): ActionKey | undefined {
	if (!isRecord(value)) return undefined;
	const { tool, input, cwd, session } = value;
	if (typeof tool !== "string" || !isRecord(input) || typeof cwd !== "string" || typeof session !== "string") {
		return undefined;
	}
	return { tool, input, cwd, session };
}

/** Restorable facts from one persisted entry; anything malformed is ignored. */
function restorable(data: unknown): { selection: Selection | null } | { denial: DenialEvent } | undefined {
	if (!isRecord(data) || data.v !== ENTRY_VERSION) return undefined;
	if (data.kind === "selection" && optionalString(data.model) && optionalString(data.effort)) {
		return { selection: data.model === null && data.effort === null ? null : { model: data.model, effort: data.effort } };
	}
	if (data.kind === "result" && typeof data.id === "string") {
		const verdict = parseVerdict(data.verdict);
		const action = parseAction(data.action);
		if (verdict?.outcome === "deny" && action) return { denial: { id: data.id, action, verdict } };
	}
	return undefined;
}

export class SessionState {
	selection: Selection | undefined;
	readonly breaker = new CircuitBreaker();
	/** Increments per agent run; reviews started in an older run do not touch the breaker. */
	runId = 0;
	#denials: DenialEvent[] = [];
	#grants = new Map<string, Grant>();
	/** Device calls already gated at their `write xd://` envelope, keyed by tool-call id and inner tool. */
	#gatedDeviceCalls = new Set<string>();
	#append: AppendEntry;

	constructor(append: AppendEntry) {
		this.#append = append;
	}

	/** Rebuild from the active branch: selection and recent denials only; live grants expire. */
	replay(entries: readonly BranchEntry[]): void {
		this.selection = undefined;
		this.#denials = [];
		this.#grants.clear();
		this.#gatedDeviceCalls.clear();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const fact = restorable(entry.data);
			if (!fact) continue;
			if ("selection" in fact) this.selection = fact.selection ?? undefined;
			else this.#rememberDenial(fact.denial);
		}
	}

	#rememberDenial(event: DenialEvent): void {
		this.#denials.push(event);
		if (this.#denials.length > APPROVE_HISTORY) this.#denials.shift();
	}

	/** Latest policy denials, newest first, one per denial event. */
	recentDenials(): DenialEvent[] {
		return [...this.#denials].reverse();
	}

	setSelection(selection: Selection | undefined): void {
		this.#append(ENTRY_TYPE, {
			v: 1,
			kind: "selection",
			model: selection?.model ?? null,
			effort: selection?.effort ?? null,
		});
		this.selection = selection && (selection.model || selection.effort) ? selection : undefined;
	}

	recordPlanAdoption(path: string, content: string, fromFile: boolean): void {
		this.#append(ENTRY_TYPE, { v: 1, kind: "plan_adoption", path, content, fromFile });
	}

	recordResult(entry: ResultEntry): void {
		this.#append(ENTRY_TYPE, entry);
		if (entry.verdict?.outcome === "deny") {
			this.#rememberDenial({ id: entry.id, action: entry.action, verdict: entry.verdict });
		}
	}

	/** Create a one-use grant after the user's explicit dialog answer. Persisted as audit before it is usable. */
	grant(kind: ApprovalKind, action: ActionKey, branchLeaf: string | null, denial?: DenialEvent): Grant {
		const id = crypto.randomUUID();
		this.#append(ENTRY_TYPE, {
			v: 1,
			kind: "approval",
			id,
			approvalKind: kind,
			denialId: denial?.id,
			action,
			branchLeaf,
			provenance: kind === "denial_retry" ? "approve_command" : "input_budget_confirm",
		});
		const grant: Grant = { id, kind, denial, action };
		this.#grants.set(id, grant);
		return grant;
	}

	/**
	 * Claim the live grant of `kind` for exactly this action, synchronously so
	 * concurrent calls cannot share it, and record its consumption. A throwing
	 * append leaves the grant claimed and propagates, blocking the action.
	 */
	claim(kind: ApprovalKind, action: ActionKey, toolCallId: string): Grant | undefined {
		for (const grant of this.#grants.values()) {
			if (grant.kind !== kind || !sameAction(grant.action, action)) continue;
			this.#grants.delete(grant.id);
			this.#append(ENTRY_TYPE, { v: 1, kind: "consumed", approvalId: grant.id, toolCallId });
			return grant;
		}
		return undefined;
	}

	/** Remember that an envelope gate covered the inner device call. */
	markDeviceGated(toolCallId: string, inner: string): void {
		this.#gatedDeviceCalls.add(`${toolCallId}\u0000${inner}`);
	}

	/** True once for the inner call of an already gated envelope. */
	takeDeviceGated(toolCallId: string, tool: string): boolean {
		return this.#gatedDeviceCalls.delete(`${toolCallId}\u0000${tool}`);
	}

	/** Expire everything bound to the live run, e.g. on agent end or a branch change. */
	expireLive(): void {
		this.#grants.clear();
		this.#gatedDeviceCalls.clear();
	}
}
