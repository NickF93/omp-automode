/**
 * Per-session review state: on/off, session overrides, recent denials,
 * one-use grants, circuit breaker, and the persisted replay union.
 *
 * Persisted entries restore only the on/off switch, the session overrides and
 * recent denials of the active branch. Grants are live, in-memory, one-use
 * claims and are never restored, so a crash or replay cannot resurrect a
 * permission.
 */
import {
	APPROVE_HISTORY,
	BREAKER_CONSECUTIVE_DENIALS,
	BREAKER_WINDOW,
	BREAKER_WINDOW_DENIALS,
} from "./policy";
import { hasOverrides, parseRules, parseTimeout, type SessionOverrides, type ShellRule } from "./settings";

export const ENTRY_TYPE = "omp-automode";
export const ENTRY_VERSION = 1;

/** The exact action a review judged. */
export interface ActionKey {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	session: string;
}

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const AUTHORIZATIONS = ["unknown", "low", "medium", "high"] as const;

export interface Verdict {
	risk_level: (typeof RISK_LEVELS)[number];
	user_authorization: (typeof AUTHORIZATIONS)[number];
	outcome: "allow" | "deny";
	rationale: string;
}

type ResultKind = "verdict" | "timeout" | "cancelled" | "failure" | "input_budget";

export interface ResultEntry {
	v: typeof ENTRY_VERSION;
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

/** Session overrides; entries written before 0.2.0 carry only model and effort. */
interface SelectionEntry {
	v: typeof ENTRY_VERSION;
	kind: "selection";
	model: string | null;
	effort: string | null;
	timeoutMs?: number | null;
	rules?: ShellRule[] | null;
	extraPolicy?: string | null;
}

/** `/auto-review on|off` for this session. */
interface EnabledEntry {
	v: typeof ENTRY_VERSION;
	kind: "enabled";
	enabled: boolean;
}

type ApprovalKind = "denial_retry" | "input_budget";

interface ApprovalEntry {
	v: typeof ENTRY_VERSION;
	kind: "approval";
	id: string;
	approvalKind: ApprovalKind;
	denialId?: string;
	action: ActionKey;
	branchLeaf: string | null;
	/** How the user answered: always an explicit plugin dialog selection. */
	provenance: "approve_command" | "input_budget_confirm";
}

interface ConsumedEntry {
	v: typeof ENTRY_VERSION;
	kind: "consumed";
	approvalId: string;
	toolCallId: string;
}

/** A plan the user approved in native plan review, recorded at its position on the branch. */
interface PlanAdoptionEntry {
	v: typeof ENTRY_VERSION;
	kind: "plan_adoption";
	path: string;
	content: string;
	/** True when `content` is the plan file read at approval, false when only the submitted snapshot was available. */
	fromFile: boolean;
}

export type PersistedEntry =
	| ResultEntry
	| SelectionEntry
	| EnabledEntry
	| ApprovalEntry
	| ConsumedEntry
	| PlanAdoptionEntry;

/** A completed policy denial offered by `/approve`. */
interface DenialEvent {
	id: string;
	action: ActionKey;
	verdict: Verdict;
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

function sameAction(a: ActionKey, b: ActionKey): boolean {
	return a.tool === b.tool && a.cwd === b.cwd && a.session === b.session && canonicalJson(a.input) === canonicalJson(b.input);
}

/** Outcome of recording one reviewed result in the breaker. */
interface BreakerTrip {
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

type AppendEntry = (customType: string, data: PersistedEntry) => void;

/** Branch entry as returned by the session manager; only custom entries matter here. */
interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The package's one structural guard for untyped session and settings data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Membership in a literal list, narrowing untyped data to the list's members. */
export function isOneOf<T>(list: readonly T[], value: unknown): value is T {
	return (list as readonly unknown[]).includes(value);
}

function optionalString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function parseVerdict(value: unknown): Verdict | undefined {
	if (!isRecord(value)) return undefined;
	const { risk_level, user_authorization, outcome, rationale } = value;
	if (!isOneOf(RISK_LEVELS, risk_level) || !isOneOf(AUTHORIZATIONS, user_authorization)) return undefined;
	if ((outcome !== "allow" && outcome !== "deny") || typeof rationale !== "string") return undefined;
	return { risk_level, user_authorization, outcome, rationale };
}

function parseAction(value: unknown): ActionKey | undefined {
	if (!isRecord(value)) return undefined;
	const { tool, input, cwd, session } = value;
	if (typeof tool !== "string" || !isRecord(input) || typeof cwd !== "string" || typeof session !== "string") {
		return undefined;
	}
	return { tool, input, cwd, session };
}

/** Session overrides from a selection entry; malformed fields reject the whole entry. */
function parseOverrides(data: Record<string, unknown>): SessionOverrides | undefined {
	const { model, effort, timeoutMs = null, rules = null, extraPolicy = null } = data;
	if (!optionalString(model) || !optionalString(effort) || !optionalString(extraPolicy)) return undefined;
	// An empty model or effort names nothing; only an empty extra policy is a deliberate override.
	if (model === "" || effort === "") return undefined;
	if (rules !== null && !Array.isArray(rules)) return undefined;
	if (timeoutMs !== null && typeof timeoutMs !== "number") return undefined;
	try {
		return {
			model,
			effort,
			extraPolicy,
			timeoutMs: timeoutMs === null ? null : (parseTimeout(timeoutMs) ?? null),
			rules: rules === null ? null : parseRules(rules),
		};
	} catch {
		return undefined;
	}
}

type Restorable = { overrides: SessionOverrides } | { enabled: boolean } | { denial: DenialEvent };

/** Restorable facts from one persisted entry; anything malformed is ignored. */
function restorable(data: unknown): Restorable | undefined {
	if (!isRecord(data) || data.v !== ENTRY_VERSION) return undefined;
	if (data.kind === "selection") {
		const overrides = parseOverrides(data);
		return overrides ? { overrides } : undefined;
	}
	if (data.kind === "enabled" && typeof data.enabled === "boolean") return { enabled: data.enabled };
	if (data.kind === "result" && typeof data.id === "string") {
		const verdict = parseVerdict(data.verdict);
		const action = parseAction(data.action);
		if (verdict?.outcome === "deny" && action) return { denial: { id: data.id, action, verdict } };
	}
	return undefined;
}

export class SessionState {
	/** Undefined when nothing is overridden. */
	overrides: SessionOverrides | undefined;
	/** False after `/auto-review off`: no call of this session is gated or reviewed. */
	enabled = true;
	readonly breaker = new CircuitBreaker();
	/** Increments per agent run; reviews started in an older run do not touch the breaker. */
	runId = 0;
	#denials: DenialEvent[] = [];
	/** Live retry grants by approval id. */
	#grants = new Map<string, DenialEvent>();
	/** Device calls already gated at their `write xd://` envelope, keyed by tool-call id and inner tool. */
	#gatedDeviceCalls = new Set<string>();
	#append: AppendEntry;

	constructor(append: AppendEntry) {
		this.#append = append;
	}

	/** Rebuild from the active branch: on/off, overrides and recent denials only; live grants expire. */
	replay(entries: readonly BranchEntry[]): void {
		this.overrides = undefined;
		this.enabled = true;
		this.#denials = [];
		this.expireLive();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const fact = restorable(entry.data);
			if (!fact) continue;
			if ("overrides" in fact) this.overrides = hasOverrides(fact.overrides) ? fact.overrides : undefined;
			else if ("enabled" in fact) this.enabled = fact.enabled;
			else this.#rememberDenial(fact.denial);
		}
	}

	/** A user-driven agent run starts: the breaker counts afresh. */
	startRun(): void {
		this.runId++;
		this.breaker.reset();
	}

	/** The run ended: its late reviews no longer touch the breaker, and its live permissions expire. */
	endRun(): void {
		this.startRun();
		this.expireLive();
	}

	#rememberDenial(event: DenialEvent): void {
		this.#denials.push(event);
		if (this.#denials.length > APPROVE_HISTORY) this.#denials.shift();
	}

	/** Latest policy denials, newest first, one per denial event. */
	recentDenials(): DenialEvent[] {
		return [...this.#denials].reverse();
	}

	setOverrides(overrides: SessionOverrides | undefined): void {
		const next = hasOverrides(overrides) ? overrides : undefined;
		this.#append(ENTRY_TYPE, {
			v: ENTRY_VERSION,
			kind: "selection",
			model: next?.model ?? null,
			effort: next?.effort ?? null,
			timeoutMs: next?.timeoutMs ?? null,
			rules: next?.rules ?? null,
			extraPolicy: next?.extraPolicy ?? null,
		});
		this.overrides = next;
	}

	setEnabled(enabled: boolean): void {
		this.#append(ENTRY_TYPE, { v: ENTRY_VERSION, kind: "enabled", enabled });
		this.enabled = enabled;
	}

	recordPlanAdoption(path: string, content: string, fromFile: boolean): void {
		this.#append(ENTRY_TYPE, { v: ENTRY_VERSION, kind: "plan_adoption", path, content, fromFile });
	}

	recordResult(entry: ResultEntry): void {
		this.#append(ENTRY_TYPE, entry);
		if (entry.verdict?.outcome === "deny") {
			this.#rememberDenial({ id: entry.id, action: entry.action, verdict: entry.verdict });
		}
	}

	/** Grant one reviewed retry of exactly the denied action after the user's `/approve` answer. Persisted as audit before it is usable. */
	grant(denial: DenialEvent, branchLeaf: string | null): void {
		const id = this.#appendApproval("denial_retry", denial.action, branchLeaf, denial.id);
		this.#grants.set(id, denial);
	}

	/**
	 * Claim the live retry grant for exactly this action, synchronously so
	 * concurrent calls cannot share it, and record its consumption. A throwing
	 * append leaves the grant claimed and propagates, blocking the action.
	 */
	claim(action: ActionKey, toolCallId: string): DenialEvent | undefined {
		for (const [id, denial] of this.#grants) {
			if (!sameAction(denial.action, action)) continue;
			this.#grants.delete(id);
			this.#append(ENTRY_TYPE, { v: ENTRY_VERSION, kind: "consumed", approvalId: id, toolCallId });
			return denial;
		}
		return undefined;
	}

	/** The user confirmed running this exact pending call without review: record the approval and its use. */
	approveManualRun(action: ActionKey, branchLeaf: string | null, toolCallId: string): void {
		const approvalId = this.#appendApproval("input_budget", action, branchLeaf);
		this.#append(ENTRY_TYPE, { v: ENTRY_VERSION, kind: "consumed", approvalId, toolCallId });
	}

	#appendApproval(kind: ApprovalKind, action: ActionKey, branchLeaf: string | null, denialId?: string): string {
		const id = crypto.randomUUID();
		this.#append(ENTRY_TYPE, {
			v: ENTRY_VERSION,
			kind: "approval",
			id,
			approvalKind: kind,
			denialId,
			action,
			branchLeaf,
			provenance: kind === "denial_retry" ? "approve_command" : "input_budget_confirm",
		});
		return id;
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

/** A session's on/off switch and overrides; subagents follow their parent's. */
export type Control = Pick<SessionState, "enabled" | "overrides">;
