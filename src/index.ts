/**
 * omp-automode: automatic synchronous review of risky tool calls.
 *
 * Wiring only: events delegate to the gate, context, reviewer and state
 * owners, and translate results into the host's `{ block, reason }`. The
 * commands live in `commands.ts`.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { version } from "../package.json";
import { registerCommands } from "./commands";
import { captureEvidence, type CaptureOptions, type PlannedAction, type TrustedInstruction } from "./context";
import { gate } from "./gate";
import {
	allowNotice,
	breakerReason,
	CANCELLED_REASON,
	denyNotice,
	denyReason,
	failureReason,
	forbiddenReason,
	HOST_TIMEOUT_HEADROOM_MS,
	inputBudgetReason,
	OFF_WARNING,
	retryApproval,
	reviewerInstructions,
	timeoutReason,
	VERDICT_CONTRACT_VERSION,
} from "./policy";
import { type ReviewResult, review } from "./reviewer";
import {
	applyOverrides,
	type AutoReviewSettings,
	type EffectiveReviewer,
	loadSettings,
	modelKey,
	modelLookup,
	releaseHostDeadline,
	requireHostDeadline,
	resolveReviewer,
	type SessionOverrides,
	SettingsError,
} from "./settings";
import { type ActionKey, canonicalJson, type Control, ENTRY_VERSION, type ResultEntry, SessionState } from "./state";

const STATUS_KEY = "omp-automode";

// ---------------------------------------------------------------------------
// Root-to-child lineage. Only real host parent identities link here.
// ---------------------------------------------------------------------------

/** What a session passes to its subagents: trusted instructions, on/off and session overrides. */
interface Lineage {
	trusted: () => TrustedInstruction[];
	control: () => Control;
}

/**
 * Agent ids are unique within one root session but two roots in one process
 * may share an id; an ambiguous parent id inherits nothing rather than another
 * root's instructions or switches.
 */
const lineageByAgent = new Map<string, Set<Lineage>>();

function parentLineage(ctx: ExtensionContext): Lineage | undefined {
	if (ctx.agent.kind !== "sub" || !ctx.agent.parentId) return undefined;
	const lineages = lineageByAgent.get(ctx.agent.parentId);
	if (!lineages || lineages.size !== 1) return undefined;
	const [lineage] = lineages;
	return lineage;
}

// ---------------------------------------------------------------------------

const AGENTS_BLOCK_RE = /<repo-rules>[\s\S]*?<\/repo-rules>|<dir-context>[\s\S]*?<\/dir-context>/g;

/** Read a plan file named by plan review: `local://` resolves under the session's artifacts directory. */
async function readPlanFile(planPath: string, ctx: ExtensionContext): Promise<string | undefined> {
	let file: string | undefined;
	if (planPath.startsWith("local://")) {
		const artifacts = ctx.sessionManager.getArtifactsDir();
		const rel = decodeURIComponent(planPath.slice("local://".length));
		if (artifacts && rel && !rel.split("/").includes("..")) file = path.join(artifacts, "local", rel);
	} else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(planPath)) {
		file = path.resolve(ctx.cwd, planPath);
	}
	if (!file) return undefined;
	try {
		return await Bun.file(file).text();
	} catch {
		return undefined;
	}
}

export default function automode(pi: ExtensionAPI): void {
	const moduleIdentity = Settings === pi.pi.Settings;
	const state = new SessionState((customType, data) => pi.appendEntry(customType, data));
	const inflight = new Set<AbortController>();
	const pendingPlans = new Map<string, { path: string; content: string }>();
	let agentsContext: string | undefined;
	let deadlineOwner: string | undefined;
	let deadlineSettings: Settings | undefined;
	let agentId: string | undefined;
	let lineage: Lineage | undefined;

	const captureOptions = (ctx: ExtensionContext, approvals: TrustedInstruction[]): CaptureOptions => ({
		isChild: ctx.agent.kind === "sub",
		agentsContext,
		inherited: parentLineage(ctx)?.trusted() ?? [],
		approvals,
	});

	/** A subagent follows its parent's switch and overrides; a root session uses its own. */
	const control = (ctx: ExtensionContext): Control =>
		parentLineage(ctx)?.control() ?? { enabled: state.enabled, overrides: state.overrides };

	/** The host's live metadata for a tool, read only when a decision needs it. */
	const toolInfo = (name: string) => pi.getAllTools().find(info => info.name === name);

	const cancelInflight = () => {
		for (const controller of inflight) controller.abort();
		inflight.clear();
	};

	const showStatus = async (ctx: ExtensionContext) => {
		const { enabled, overrides } = control(ctx);
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "auto-review OFF"));
			return;
		}
		try {
			const reviewer = resolveReviewer(await loadSettings(ctx.cwd), overrides, modelLookup(ctx, pi));
			ctx.ui.setStatus(STATUS_KEY, `auto-review ${modelKey(reviewer.model)}${reviewer.effort ? `:${reviewer.effort}` : ""}`);
		} catch (error) {
			ctx.ui.setStatus(STATUS_KEY, `auto-review: ${(error as Error).message}`);
		}
	};

	/** Raise the host's per-handler budget on this session's scoped Settings to fit a review of `timeoutMs`. */
	const raiseDeadline = (ctx: ExtensionContext, timeoutMs: number) => {
		const scoped = findScopedSettings();
		if (!moduleIdentity || !scoped) return;
		deadlineOwner ??= `${ctx.sessionManager.getSessionId()}:${crypto.randomUUID()}`;
		if (deadlineSettings && deadlineSettings !== scoped) releaseHostDeadline(deadlineSettings, deadlineOwner);
		deadlineSettings = scoped;
		requireHostDeadline(scoped, deadlineOwner, timeoutMs + HOST_TIMEOUT_HEADROOM_MS);
	};

	/** Before tool dispatch: apply the effective timeout, or say why the deadline cannot be raised. */
	const ensureDeadline = async (ctx: ExtensionContext) => {
		if (!moduleIdentity) {
			ctx.ui.notify("omp-automode: host settings module differs; review deadline above the host default is unavailable", "warning");
			return;
		}
		try {
			raiseDeadline(ctx, applyOverrides(await loadSettings(ctx.cwd), control(ctx).overrides).timeoutMs);
		} catch {
			// Invalid settings block every reviewed call with their own reason.
		}
	};

	/** Re-apply the host deadline, then the status line. */
	const refresh = async (ctx: ExtensionContext) => {
		await ensureDeadline(ctx);
		await showStatus(ctx);
	};

	const unregisterLineage = () => {
		if (agentId === undefined || !lineage) return;
		const lineages = lineageByAgent.get(agentId);
		lineages?.delete(lineage);
		if (lineages?.size === 0) lineageByAgent.delete(agentId);
	};

	/** Restore the active branch's state; a restored or resumed root session that is off says so. */
	const onTransition = async (_event: unknown, ctx: ExtensionContext) => {
		cancelInflight();
		state.replay(ctx.sessionManager.getBranch());
		await refresh(ctx);
		// Subagents follow their parent's switch silently.
		if (ctx.agent.kind !== "sub" && !state.enabled) ctx.ui.notify(OFF_WARNING, "warning");
	};

	pi.on("session_start", async (event, ctx) => {
		unregisterLineage();
		const sessionManager = ctx.sessionManager;
		agentId = ctx.agent.id;
		lineage = {
			trusted: () => captureEvidence(sessionManager.getBranch(), captureOptions(ctx, [])).trusted,
			control: () => control(ctx),
		};
		const lineages = lineageByAgent.get(agentId) ?? new Set();
		lineages.add(lineage);
		lineageByAgent.set(agentId, lineages);
		await onTransition(event, ctx);
	});
	pi.on("session_switch", onTransition);
	pi.on("session_branch", onTransition);
	pi.on("session_tree", onTransition);
	pi.on("session_shutdown", () => {
		cancelInflight();
		state.expireLive();
		if (deadlineSettings && deadlineOwner) releaseHostDeadline(deadlineSettings, deadlineOwner);
		deadlineSettings = undefined;
		unregisterLineage();
	});

	pi.on("before_agent_start", event => {
		const blocks = event.systemPrompt.join("\n").match(AGENTS_BLOCK_RE);
		agentsContext = blocks ? blocks.join("\n") : undefined;
	});
	pi.on("agent_start", async (_event, ctx) => {
		state.startRun();
		await ensureDeadline(ctx);
	});
	pi.on("agent_end", () => {
		cancelInflight();
		state.endRun();
	});

	pi.on("plan_review_requested", event => {
		pendingPlans.set(event.reviewId, { path: event.planFilePath, content: event.planContent });
	});
	pi.on("plan_review_resolved", async (event, ctx) => {
		const plan = pendingPlans.get(event.reviewId);
		pendingPlans.delete(event.reviewId);
		if (!plan || event.by !== "local") return;
		if (event.choice !== "execute" && event.choice !== "keep" && event.choice !== "compact") return;
		// The approval executes the plan file as it is when picked, which can differ from the
		// requested snapshot after in-review edits: prefer the file's content now.
		const approved = await readPlanFile(plan.path, ctx);
		try {
			state.recordPlanAdoption(plan.path, approved ?? plan.content, approved !== undefined);
		} catch {
			// Not persisted: the plan simply carries no adoption evidence.
		}
	});

	pi.on("tool_call", async (event, ctx) => handleToolCall(event, ctx));

	registerCommands(pi, { state, control, refresh, showStatus });

	async function handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const { enabled, overrides } = control(ctx);
		// Off means off: no rule, gate or review applies until `/auto-review on`.
		if (!enabled) return undefined;
		if (state.takeDeviceGated(event.toolCallId, event.toolName)) return undefined;
		let settings: AutoReviewSettings;
		try {
			settings = applyOverrides(await loadSettings(ctx.cwd), overrides);
		} catch (error) {
			return { block: true, reason: failureReason(`invalid omp-automode settings: ${(error as Error).message}`) };
		}
		// A subagent follows a timeout its parent changed mid-run from its next call on.
		raiseDeadline(ctx, settings.timeoutMs);
		// Every tool's event input is a JSON object; the typed variants only name known fields.
		const input = event.input as Record<string, unknown>;
		const callCwd = event.toolName === "bash" && typeof input.cwd === "string" ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const decision = gate({ toolName: event.toolName, input, cwd: callCwd, rules: settings.rules, toolInfo });
		if (decision.xdInner) state.markDeviceGated(event.toolCallId, decision.xdInner);
		if (decision.kind === "skip") return undefined;
		if (decision.kind === "forbidden") {
			return { block: true, reason: forbiddenReason(decision.rule.prefix, decision.command) };
		}
		let tool = event.toolName;
		let toolInput = input;
		let via: string | undefined;
		if (decision.xdInner) {
			tool = decision.xdInner;
			via = `write xd://${decision.xdInner}`;
			toolInput = JSON.parse(String(input.content)) as Record<string, unknown>;
		}
		return runReview(ctx, settings, overrides, {
			tool,
			input: toolInput,
			cwd: callCwd,
			via,
			toolCallId: event.toolCallId,
			toolDescription: toolInfo(tool)?.description,
		});
	}

	async function runReview(
		ctx: ExtensionContext,
		settings: AutoReviewSettings,
		overrides: SessionOverrides | undefined,
		call: { tool: string; input: Record<string, unknown>; cwd: string; via?: string; toolCallId: string; toolDescription?: string },
	): Promise<ToolCallEventResult | undefined> {
		const sessionId = ctx.sessionManager.getSessionId();
		const actionKey: ActionKey = { tool: call.tool, input: call.input, cwd: call.cwd, session: sessionId };
		let reviewer: EffectiveReviewer;
		try {
			reviewer = resolveReviewer(settings, overrides, modelLookup(ctx, pi));
		} catch (error) {
			if (error instanceof SettingsError) return { block: true, reason: failureReason(error.message) };
			throw error;
		}

		const approvals: TrustedInstruction[] = [];
		try {
			const denial = state.claim(actionKey, call.toolCallId);
			if (denial) {
				approvals.push(retryApproval(denial.verdict, canonicalJson({ tool: call.tool, input: call.input, cwd: call.cwd })));
			}
		} catch (error) {
			return { block: true, reason: failureReason(`could not record the approval's use: ${(error as Error).message}`) };
		}

		const action: PlannedAction = {
			tool: call.tool,
			input: call.input,
			cwd: call.cwd,
			agent: { ...ctx.agent },
			session: sessionId,
			via: call.via,
			toolDescription: call.toolDescription,
		};
		const instructions = reviewerInstructions(settings, call.tool);
		const controller = new AbortController();
		inflight.add(controller);
		const runId = state.runId;
		ctx.ui.setWorkingMessage("Automatic approval review…");
		let result: ReviewResult;
		try {
			result = await review({
				model: reviewer.model,
				effort: reviewer.effort,
				timeoutMs: settings.timeoutMs,
				instructions,
				action,
				capture: () => captureEvidence(ctx.sessionManager.getBranch(), captureOptions(ctx, approvals)),
				apiKey: ctx.modelRegistry.resolver(reviewer.model, `${sessionId}:auto-review`),
				sessionId: `${sessionId}:auto-review`,
				signal: controller.signal,
			});
		} finally {
			inflight.delete(controller);
			ctx.ui.setWorkingMessage();
		}

		const entry: ResultEntry = {
			v: ENTRY_VERSION,
			kind: "result",
			id: crypto.randomUUID(),
			runId: String(runId),
			toolCallId: call.toolCallId,
			action: actionKey,
			model: modelKey(reviewer.model),
			effort: reviewer.effort ?? null,
			result: result.kind,
			...(result.kind === "verdict" ? { verdict: result.verdict } : {}),
			...(result.kind === "failure" || result.kind === "input_budget" ? { detail: result.detail } : {}),
			provenance: {
				packageVersion: version,
				verdictContract: VERDICT_CONTRACT_VERSION,
				instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
			},
			...result.stats,
		};
		try {
			state.recordResult(entry);
		} catch (error) {
			ctx.ui.notify(`omp-automode: could not persist the review result: ${(error as Error).message}`, "warning");
		}
		const currentRun = runId === state.runId;
		const denied = result.kind === "verdict" && result.verdict.outcome === "deny";
		const trip = currentRun ? state.breaker.record(denied) : undefined;

		switch (result.kind) {
			case "verdict": {
				const v = result.verdict;
				if (v.outcome === "allow") {
					ctx.ui.notify(allowNotice(v), "info");
					return undefined;
				}
				ctx.ui.notify(denyNotice(v), "warning");
				let reason = denyReason(v);
				if (trip) {
					const tripText = breakerReason(trip.consecutive, trip.inWindow, trip.windowSize);
					ctx.ui.notify(tripText, "warning");
					reason = `${reason}\n\n${tripText}`;
					ctx.abort();
				}
				return { block: true, reason };
			}
			case "timeout": {
				const reason = timeoutReason(settings.timeoutMs);
				ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			case "cancelled":
				return { block: true, reason: CANCELLED_REASON };
			case "failure": {
				const reason = failureReason(result.detail);
				ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			case "input_budget":
				return manualFallback(ctx, actionKey, call.toolCallId, result.detail);
		}
	}

	/** Context exhaustion: only the user's explicit confirmation of this exact pending call can run it. */
	async function manualFallback(
		ctx: ExtensionContext,
		action: ActionKey,
		toolCallId: string,
		detail: string,
	): Promise<ToolCallEventResult | undefined> {
		const blocked = { block: true, reason: inputBudgetReason(detail) };
		if (!ctx.hasUI) return blocked;
		const confirmed = await ctx.ui.confirm(
			"Automatic review cannot assess this action",
			`The reviewer model's context cannot hold this action with its minimum evidence (${detail}). No risk assessment was made.\n\nRun exactly this pending call without review?\n\n${JSON.stringify({ tool: action.tool, input: action.input, cwd: action.cwd }, null, 2)}`,
		);
		if (!confirmed) return blocked;
		try {
			state.approveManualRun(action, ctx.sessionManager.getLeafId(), toolCallId);
		} catch (error) {
			return { block: true, reason: failureReason(`could not record the manual approval: ${(error as Error).message}`) };
		}
		return undefined;
	}
}
