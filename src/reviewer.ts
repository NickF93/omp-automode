/**
 * Synchronous review: up to three independent attempts under one deadline,
 * each a private reviewer conversation with read-only sandbox investigation,
 * ending in a parsed verdict or a technical result that is never a denial.
 */
import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	completeSimple,
	type Effort,
	type Message,
	type Model,
	type ToolCall,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { classify, Flag, is, isTransientStatus, status } from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { admit, type EvidenceSnapshot, estimateRequest, type PlannedAction } from "./context";
import { defaultRationale, MAX_ATTEMPTS, RETRY_BASE_DELAY_MS } from "./policy";
import { INVESTIGATION_TOOLS, Sandbox, SandboxUnavailableError } from "./sandbox";
import type { Verdict } from "./state";

export interface ReviewStats {
	attempts: number;
	checkpointRestarts: number;
	samplingRequests: number;
	elapsedMs: number;
}

export type ReviewResult =
	| { kind: "verdict"; verdict: Verdict; stats: ReviewStats }
	| { kind: "timeout"; stats: ReviewStats }
	| { kind: "cancelled"; stats: ReviewStats }
	| { kind: "failure"; detail: string; stats: ReviewStats }
	| { kind: "input_budget"; detail: string; stats: ReviewStats };

export interface ReviewRequest {
	model: Model<Api>;
	effort: string | undefined;
	timeoutMs: number;
	/** Rendered policy plus output contract. */
	instructions: string;
	action: PlannedAction;
	/** Capture a fresh immutable evidence snapshot. */
	capture: () => EvidenceSnapshot;
	/** Fingerprint of the trusted instructions as they are now. */
	currentTrust: () => string;
	apiKey: ApiKey;
	/** Reviewer session id, distinct from the main conversation's provider lineage. */
	sessionId: string;
	/** Cancels the review (run ended, session changed, shutdown). */
	signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

const RISK_LEVELS: readonly string[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly string[] = ["unknown", "low", "medium", "high"];

export class VerdictParseError extends Error {
	override readonly name = "VerdictParseError";
}

/**
 * Accept the whole text as JSON, else the span from the first `{` to the last
 * `}`. Only `outcome` is required; absent or null fields take defaults, while
 * present invalid values fail the parse rather than becoming an allow.
 */
export function parseVerdict(text: string): Verdict {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) throw new VerdictParseError("reviewer answer was not JSON");
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			throw new VerdictParseError("reviewer answer was not valid JSON");
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new VerdictParseError("reviewer answer was not a JSON object");
	}
	const raw = parsed as Record<string, unknown>;
	const outcome = raw.outcome;
	if (outcome !== "allow" && outcome !== "deny") throw new VerdictParseError("reviewer answer has no valid outcome");
	const risk = raw.risk_level ?? (outcome === "allow" ? "low" : "high");
	if (typeof risk !== "string" || !RISK_LEVELS.includes(risk)) throw new VerdictParseError("invalid risk_level");
	const authorization = raw.user_authorization ?? "unknown";
	if (typeof authorization !== "string" || !AUTHORIZATIONS.includes(authorization)) {
		throw new VerdictParseError("invalid user_authorization");
	}
	const rationale = raw.rationale;
	if (rationale !== undefined && rationale !== null && typeof rationale !== "string") {
		throw new VerdictParseError("invalid rationale");
	}
	return {
		outcome,
		risk_level: risk as Verdict["risk_level"],
		user_authorization: authorization as Verdict["user_authorization"],
		rationale: typeof rationale === "string" && rationale.trim() ? rationale.trim() : defaultRationale(outcome),
	};
}

// ---------------------------------------------------------------------------
// Attempt outcomes and retry classification
// ---------------------------------------------------------------------------

type AttemptOutcome =
	| { kind: "verdict"; verdict: Verdict; fingerprint: string }
	| { kind: "parse_error"; detail: string }
	| { kind: "service_error"; detail: string; retryable: boolean; retryAfterMs?: number }
	| { kind: "input_budget"; detail: string }
	| { kind: "aborted" }
	| { kind: "failure"; detail: string };

/** Whether a failed model response is worth another independent attempt. */
export function isRetryableResponse(message: Pick<AssistantMessage, "errorStatus" | "errorId">): boolean {
	if (message.errorStatus !== undefined) return isTransientStatus(message.errorStatus);
	// No status: only a positively classified transient transport failure qualifies.
	return is(message.errorId, Flag.Transient) && !is(message.errorId, Flag.UsageLimit) && !is(message.errorId, Flag.AuthFailed);
}

function isContextOverflow(message: Pick<AssistantMessage, "errorId">): boolean {
	return is(message.errorId, Flag.ContextOverflow);
}

function errorDetail(message: AssistantMessage): string {
	const text = (message.errorMessage ?? "model request failed").replace(/\s+/g, " ").slice(0, 300);
	return message.errorStatus ? `${text} (HTTP ${message.errorStatus})` : text;
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

interface AttemptCounters {
	checkpointRestarts: number;
	/** Model requests, including the transport's internal replays. */
	samplingRequests: number;
}

async function runAttempt(
	req: ReviewRequest,
	signal: AbortSignal,
	counters: AttemptCounters,
	retryReason: string | undefined,
): Promise<AttemptOutcome> {
	// Frozen checkpoint: one evidence snapshot per attempt; a restart rebuilds from it.
	const snapshot = req.capture();
	const systemPrompt = [req.instructions];
	const imageInput = req.model.input.includes("image");
	let restarted = false;

	for (;;) {
		const sandbox = new Sandbox(req.action.cwd, imageInput);
		let sandboxChecked = false;
		/** Completed groups: one assistant message plus all its tool results. */
		const groups: Message[][] = [];
		let omittedSteps = 0;
		let needRestart = false;
		/** Set once when the server rejects a request the local estimate admitted. */
		let ceilingTokens: number | undefined;
		try {
			for (;;) {
				// Admit evidence against the cost of the private history. Optional evidence goes
				// first, then the oldest completed steps (never the newest); only then may older
				// trusted instructions be shortened.
				const tryAdmit = (shortenTrusted: boolean) =>
					admit(
						snapshot,
						req.action,
						systemPrompt,
						INVESTIGATION_TOOLS,
						req.model,
						{ imageInput, retryReason, omittedSteps, shortenTrusted, ceilingTokens },
						historyTokens(groups),
					);
				let admission = tryAdmit(false);
				while (!admission.ok && groups.length > 1) {
					groups.shift();
					omittedSteps++;
					admission = tryAdmit(false);
				}
				if (!admission.ok) admission = tryAdmit(true);
				if (!admission.ok) {
					if (groups.length === 0) return { kind: "input_budget", detail: admission.reason };
					needRestart = true;
					break;
				}
				if (signal.aborted) return { kind: "aborted" };
				let nativeAttempts = 0;
				let response: AssistantMessage;
				try {
					response = await completeSimple(
						req.model,
						{ systemPrompt, messages: [admission.message, ...groups.flat()], tools: INVESTIGATION_TOOLS },
						{
							apiKey: req.apiKey,
							sessionId: req.sessionId,
							signal,
							maxHttpAttempts: 1,
							...(req.effort ? { reasoning: req.effort as Effort } : {}),
							// The transport may replay internally; each completed attempt is a sampling request.
							onAttempt: () => nativeAttempts++,
						},
					);
				} catch (error) {
					counters.samplingRequests += Math.max(1, nativeAttempts);
					if (signal.aborted) return { kind: "aborted" };
					const code = status(error);
					const message = String((error as Error)?.message ?? error);
					const retryable = code !== undefined ? isTransientStatus(code) : is(classify(error), Flag.Transient);
					return {
						kind: "service_error",
						detail: message.slice(0, 300),
						retryable,
						retryAfterMs: extractProviderRetryHint(req.model.provider, message),
					};
				}
				counters.samplingRequests += Math.max(1, nativeAttempts);
				if (response.stopReason === "aborted" || signal.aborted) return { kind: "aborted" };
				if (response.stopReason === "error") {
					if (!isContextOverflow(response)) {
						return {
							kind: "service_error",
							detail: errorDetail(response),
							retryable: isRetryableResponse(response),
							retryAfterMs: extractProviderRetryHint(req.model.provider, response.errorMessage),
						};
					}
					// The server's own limit was hit: drop an older step, else restart from the checkpoint.
					if (groups.length > 1) {
						groups.shift();
						omittedSteps++;
						continue;
					}
					if (groups.length === 0) {
						// The local estimate was too optimistic: recover evidence once against a lower ceiling.
						if (ceilingTokens === undefined && admission.ok) {
							ceilingTokens = Math.floor(admission.tokens * 0.75);
							continue;
						}
						return { kind: "input_budget", detail: "the reviewer request exceeds the model's context window" };
					}
					needRestart = true;
					break;
				}
				const calls = response.content.filter((part): part is ToolCall => part.type === "toolCall");
				if (calls.length === 0) {
					const text = response.content.map(part => (part.type === "text" ? part.text : "")).join("");
					try {
						return { kind: "verdict", verdict: parseVerdict(text), fingerprint: snapshot.trustFingerprint };
					} catch (error) {
						return { kind: "parse_error", detail: (error as Error).message };
					}
				}
				if (!sandboxChecked) {
					try {
						await Sandbox.probe();
					} catch (error) {
						if (error instanceof SandboxUnavailableError) return { kind: "failure", detail: error.message };
						throw error;
					}
					sandboxChecked = true;
				}
				const results = await Promise.all(
					calls.map(async (call): Promise<ToolResultMessage> => {
						const outcome = await sandbox.run(call.name, call.arguments, signal);
						return {
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: outcome.image ? [{ type: "text", text: outcome.text }, outcome.image] : [{ type: "text", text: outcome.text }],
							isError: outcome.isError,
							timestamp: Date.now(),
						};
					}),
				);
				if (signal.aborted) return { kind: "aborted" };
				groups.push([response, ...results]);
			}
		} finally {
			await sandbox.dispose();
		}
		if (!needRestart) continue;
		// One checkpoint restart per attempt, with fresh processes and no discarded history.
		if (restarted) return { kind: "input_budget", detail: "investigation exceeded the context window again after a restart" };
		restarted = true;
		counters.checkpointRestarts++;
	}
}

function historyTokens(groups: readonly Message[][]): number {
	const history = groups.flat();
	return history.length > 0 ? estimateRequest([], [], history) : 0;
}

// ---------------------------------------------------------------------------
// Attempts, deadline and backoff
// ---------------------------------------------------------------------------

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted || ms <= 0) {
		resolve();
		return promise;
	}
	const timer = setTimeout(done, ms);
	signal.addEventListener("abort", done, { once: true });
	function done() {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	}
	return promise;
}

/** Run one review to a final result within the deadline. */
export async function review(req: ReviewRequest): Promise<ReviewResult> {
	const started = Date.now();
	const deadline = started + req.timeoutMs;
	const deadlineController = new AbortController();
	const timer = setTimeout(() => deadlineController.abort(), req.timeoutMs);
	const signal = AbortSignal.any([req.signal, deadlineController.signal]);
	const counters: AttemptCounters = { checkpointRestarts: 0, samplingRequests: 0 };
	let attempts = 0;
	const stats = (): ReviewStats => ({
		attempts,
		checkpointRestarts: counters.checkpointRestarts,
		samplingRequests: counters.samplingRequests,
		elapsedMs: Date.now() - started,
	});
	const ended = (): ReviewResult =>
		req.signal.aborted ? { kind: "cancelled", stats: stats() } : { kind: "timeout", stats: stats() };
	let retryReason: string | undefined;
	try {
		for (;;) {
			attempts++;
			const outcome = await runAttempt(req, signal, counters, retryReason);
			let backoff = true;
			let retryAfterMs = 0;
			switch (outcome.kind) {
				case "verdict":
					if (outcome.fingerprint === req.currentTrust()) {
						return { kind: "verdict", verdict: outcome.verdict, stats: stats() };
					}
					// Authorization changed while the reviewer worked: recapture without service backoff.
					retryReason = "trusted instructions changed during review";
					backoff = false;
					break;
				case "parse_error":
					retryReason = outcome.detail;
					break;
				case "service_error":
					if (!outcome.retryable) return { kind: "failure", detail: outcome.detail, stats: stats() };
					retryReason = outcome.detail;
					retryAfterMs = outcome.retryAfterMs ?? 0;
					break;
				case "aborted":
					return ended();
				case "input_budget":
					return { kind: "input_budget", detail: outcome.detail, stats: stats() };
				case "failure":
					return { kind: "failure", detail: outcome.detail, stats: stats() };
			}
			if (attempts >= MAX_ATTEMPTS) {
				return { kind: "failure", detail: `${retryReason} after ${attempts} attempts`, stats: stats() };
			}
			if (backoff) {
				// The later of jittered backoff and the provider's retry time, bounded by the deadline below.
				const delay = Math.max(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1) * (0.9 + Math.random() * 0.2), retryAfterMs);
				await sleepUntil(Math.min(delay, deadline - Date.now()), signal);
			} else {
				await Bun.sleep(0);
			}
			if (signal.aborted || Date.now() >= deadline) return ended();
		}
	} finally {
		clearTimeout(timer);
	}
}
