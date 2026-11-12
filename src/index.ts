/**
 * omp-automode: automatic synchronous review of risky tool calls.
 *
 * Wiring only: events and commands delegate to the gate, context, reviewer and
 * state owners, and translate results into the host's `{ block, reason }`.
 */
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { captureEvidence, type CaptureOptions, type PlannedAction, type TrustedInstruction } from "./context";
import { gate, type GateToolInfo } from "./gate";
import {
	allowNotice,
	BROWSER_POLICY,
	breakerReason,
	CANCELLED_REASON,
	DEFAULT_POLICY,
	DEFAULT_POLICY_TEMPLATE,
	denyNotice,
	denyReason,
	failureReason,
	HOST_TIMEOUT_HEADROOM_MS,
	inputBudgetReason,
	OUTPUT_CONTRACT,
	renderPolicy,
	timeoutReason,
} from "./policy";
import { type ReviewResult, review } from "./reviewer";
import {
	type AutoReviewSettings,
	type EffectiveReviewer,
	loadSettings,
	type ModelLookup,
	modelKey,
	releaseHostDeadline,
	requireHostDeadline,
	resolveReviewer,
	type Selection,
	SettingsError,
	supportedEfforts,
} from "./settings";
import { type ActionKey, canonicalJson, type ResultEntry, SessionState } from "./state";

const STATUS_KEY = "omp-automode";

// ---------------------------------------------------------------------------
// Root-to-child trusted context. Only real host parent identities link here.
// ---------------------------------------------------------------------------

/**
 * Agent ids are unique within one root session but two roots in one process
 * may share an id; an ambiguous parent id inherits nothing rather than another
 * root's instructions.
 */
const trustedByAgent = new Map<string, Set<() => TrustedInstruction[]>>();

function inheritedFor(ctx: ExtensionContext): TrustedInstruction[] {
	if (ctx.agent.kind !== "sub" || !ctx.agent.parentId) return [];
	const getters = trustedByAgent.get(ctx.agent.parentId);
	if (!getters || getters.size !== 1) return [];
	const [getter] = getters;
	return getter?.() ?? [];
}

// ---------------------------------------------------------------------------

const AGENTS_BLOCK_RE = /<repo-rules>[\s\S]*?<\/repo-rules>|<dir-context>[\s\S]*?<\/dir-context>/g;
/**
 * Browser/computer rules accompany every call that can drive a browser: eval
 * and debug keep live aliases across calls, so the input text cannot tell.
 * The rules themselves apply only to actual browser activity.
 */
function canDriveBrowser(tool: string): boolean {
	return tool === "computer" || tool === "browser" || tool === "eval" || tool === "debug";
}

function modelLookup(ctx: ExtensionContext, pi: ExtensionAPI): ModelLookup {
	return {
		resolve: spec => ctx.models.resolve(spec),
		list: () => ctx.models.list(),
		current: () => ctx.model,
		currentEffort: () => pi.getThinkingLevel(),
	};
}

function describeReviewer(reviewer: EffectiveReviewer): string {
	return `${modelKey(reviewer.model)}${reviewer.effort ? `:${reviewer.effort}` : ""} (model from ${reviewer.modelSource}, effort from ${reviewer.effortSource})`;
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
	let lineageGetter: (() => TrustedInstruction[]) | undefined;

	const captureOptions = (ctx: ExtensionContext, approvals: TrustedInstruction[]): CaptureOptions => ({
		isChild: ctx.agent.kind === "sub",
		agentsContext,
		inherited: inheritedFor(ctx),
		approvals,
	});

	const cancelInflight = () => {
		for (const controller of inflight) controller.abort();
		inflight.clear();
	};

	const showStatus = async (ctx: ExtensionContext) => {
		try {
			const settings = await loadSettings(ctx.cwd);
			const reviewer = resolveReviewer(settings, state.selection, modelLookup(ctx, pi));
			ctx.ui.setStatus(STATUS_KEY, `auto-review ${modelKey(reviewer.model)}${reviewer.effort ? `:${reviewer.effort}` : ""}`);
		} catch (error) {
			ctx.ui.setStatus(STATUS_KEY, `auto-review: ${(error as Error).message}`);
		}
	};

	/** Raise the host's per-handler budget on this session's scoped Settings before tool dispatch. */
	const ensureDeadline = async (ctx: ExtensionContext) => {
		if (!moduleIdentity) {
			ctx.ui.notify("omp-automode: host settings module differs; review deadline above the host default is unavailable", "warning");
			return;
		}
		const scoped = findScopedSettings();
		if (!scoped) return;
		let timeoutMs: number;
		try {
			timeoutMs = (await loadSettings(ctx.cwd)).timeoutMs;
		} catch {
			return;
		}
		deadlineOwner ??= `${ctx.sessionManager.getSessionId()}:${crypto.randomUUID()}`;
		if (deadlineSettings && deadlineSettings !== scoped) releaseHostDeadline(deadlineSettings, deadlineOwner);
		deadlineSettings = scoped;
		requireHostDeadline(scoped, deadlineOwner, timeoutMs + HOST_TIMEOUT_HEADROOM_MS);
	};

	const restore = (ctx: ExtensionContext) => {
		cancelInflight();
		state.replay(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		const sessionManager = ctx.sessionManager;
		const snapshotCtx = ctx;
		if (agentId !== undefined && lineageGetter) trustedByAgent.get(agentId)?.delete(lineageGetter);
		agentId = ctx.agent.id;
		lineageGetter = () => captureEvidence(sessionManager.getBranch(), captureOptions(snapshotCtx, [])).trusted;
		const getters = trustedByAgent.get(agentId) ?? new Set();
		getters.add(lineageGetter);
		trustedByAgent.set(agentId, getters);
		await ensureDeadline(ctx);
		await showStatus(ctx);
	});
	const onTransition = async (_event: unknown, ctx: ExtensionContext) => {
		restore(ctx);
		await showStatus(ctx);
	};
	pi.on("session_switch", onTransition);
	pi.on("session_branch", onTransition);
	pi.on("session_tree", onTransition);
	pi.on("session_shutdown", () => {
		cancelInflight();
		state.expireLive();
		if (deadlineSettings && deadlineOwner) releaseHostDeadline(deadlineSettings, deadlineOwner);
		deadlineSettings = undefined;
		if (agentId !== undefined && lineageGetter) {
			const getters = trustedByAgent.get(agentId);
			getters?.delete(lineageGetter);
			if (getters?.size === 0) trustedByAgent.delete(agentId);
		}
	});

	pi.on("before_agent_start", event => {
		const blocks = event.systemPrompt.join("\n").match(AGENTS_BLOCK_RE);
		agentsContext = blocks ? blocks.join("\n") : undefined;
	});
	pi.on("agent_start", async (_event, ctx) => {
		state.runId++;
		state.breaker.reset();
		await ensureDeadline(ctx);
	});
	pi.on("agent_end", () => {
		cancelInflight();
		state.runId++;
		state.breaker.reset();
		state.expireLive();
	});

	pi.on("plan_review_requested", event => {
		pendingPlans.set(event.reviewId, { path: event.planFilePath, content: event.planContent });
	});
	pi.on("plan_review_resolved", event => {
		const plan = pendingPlans.get(event.reviewId);
		pendingPlans.delete(event.reviewId);
		if (!plan || event.by !== "local") return;
		if (event.choice !== "execute" && event.choice !== "keep" && event.choice !== "compact") return;
		try {
			// The user may edit the plan inside the review before approving; this is the submitted text.
			state.recordPlanAdoption(plan.path, plan.content);
		} catch {
			// Not persisted: the plan simply carries no adoption evidence.
		}
	});

	pi.on("tool_call", async (event, ctx) => handleToolCall(event, ctx));

	async function handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (state.takeDeviceGated(event.toolCallId, event.toolName)) return undefined;
		let settings: AutoReviewSettings;
		try {
			settings = await loadSettings(ctx.cwd);
		} catch (error) {
			return { block: true, reason: failureReason(`invalid omp-automode settings: ${(error as Error).message}`) };
		}
		// Every tool's event input is a JSON object; the typed variants only name known fields.
		const input = event.input as Record<string, unknown>;
		const callCwd = event.toolName === "bash" && typeof input.cwd === "string" ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;
		const tools = new Map<string, GateToolInfo>(
			pi.getAllTools().map(info => [
				info.name,
				{
					name: info.name,
					description: info.description,
					mcpServerName: info.mcpServerName,
					mcpReadOnlyHint: info.mcpReadOnlyHint,
					source: info.sourceInfo.source,
				},
			]),
		);
		const decision = gate({ toolName: event.toolName, input, cwd: callCwd, rules: settings.rules, tools });
		if (decision.xdInner) state.markDeviceGated(event.toolCallId, decision.xdInner);
		if (decision.kind === "skip") return undefined;
		if (decision.kind === "forbidden") {
			return {
				block: true,
				reason: `Blocked by the user's forbidden shell rule [${decision.rule.prefix.join(" ")}] matching: ${decision.command.join(" ")}. The action did not run.`,
			};
		}
		let tool = event.toolName;
		let toolInput = input;
		let via: string | undefined;
		if (decision.xdInner) {
			tool = decision.xdInner;
			via = `write xd://${decision.xdInner}`;
			toolInput = JSON.parse(String(input.content)) as Record<string, unknown>;
		}
		return runReview(ctx, settings, {
			tool,
			input: toolInput,
			cwd: callCwd,
			via,
			toolCallId: event.toolCallId,
			toolDescription: tools.get(tool)?.description,
		});
	}

	async function runReview(
		ctx: ExtensionContext,
		settings: AutoReviewSettings,
		call: { tool: string; input: Record<string, unknown>; cwd: string; via?: string; toolCallId: string; toolDescription?: string },
	): Promise<ToolCallEventResult | undefined> {
		const sessionId = ctx.sessionManager.getSessionId();
		const actionKey: ActionKey = { tool: call.tool, input: call.input, cwd: call.cwd, session: sessionId };
		let reviewer: EffectiveReviewer;
		try {
			reviewer = resolveReviewer(settings, state.selection, modelLookup(ctx, pi));
		} catch (error) {
			if (error instanceof SettingsError) return { block: true, reason: failureReason(error.message) };
			throw error;
		}

		const approvals: TrustedInstruction[] = [];
		try {
			const grant = state.claim("denial_retry", actionKey, call.toolCallId);
			if (grant?.denial) {
				approvals.push({
					source: "explicit approval the user selected in /approve",
					text: `After the review denied this exact action (risk ${grant.denial.verdict.risk_level}: ${grant.denial.verdict.rationale}), the user explicitly approved retrying exactly this action once: ${canonicalJson({ tool: call.tool, input: call.input, cwd: call.cwd })}`,
				});
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
		const template = settings.policyTemplate ?? DEFAULT_POLICY_TEMPLATE;
		const policy = `${settings.policy ?? DEFAULT_POLICY}${canDriveBrowser(call.tool) ? `\n\n${BROWSER_POLICY}` : ""}`;
		const instructions = `${renderPolicy(template, policy, settings.extraPolicy ?? "")}\n\n${OUTPUT_CONTRACT}`;
		const capture = () => captureEvidence(ctx.sessionManager.getBranch(), captureOptions(ctx, approvals));
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
				capture,
				currentTrust: () => capture().trustFingerprint,
				apiKey: ctx.modelRegistry.resolver(reviewer.model, `${sessionId}:auto-review`),
				sessionId: `${sessionId}:auto-review`,
				signal: controller.signal,
			});
		} finally {
			inflight.delete(controller);
			ctx.ui.setWorkingMessage();
		}

		const entry: ResultEntry = {
			v: 1,
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
			state.grant("input_budget", action, ctx.sessionManager.getLeafId());
			if (!state.claim("input_budget", action, toolCallId)) return blocked;
		} catch (error) {
			return { block: true, reason: failureReason(`could not record the manual approval: ${(error as Error).message}`) };
		}
		return undefined;
	}

	pi.registerCommand("approve", {
		description: "Approve one reviewed retry of a recently denied action",
		handler: async (_args, ctx) => approveCommand(ctx),
	});

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
		state.grant("denial_retry", denial.action, ctx.sessionManager.getLeafId(), denial);
		ctx.ui.notify(
			"Approved one retry of exactly that action. It will be reviewed again with your approval as context; a changed action is reviewed normally.",
			"info",
		);
	}

	pi.registerCommand("auto-review", {
		description: "Show or change the automatic reviewer's model and reasoning effort",
		handler: async (_args, ctx) => autoReviewCommand(ctx),
	});

	async function autoReviewCommand(ctx: ExtensionCommandContext): Promise<void> {
		let settings: AutoReviewSettings;
		try {
			settings = await loadSettings(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`omp-automode settings are invalid: ${(error as Error).message}`, "error");
			return;
		}
		const lookupModels = modelLookup(ctx, pi);
		let effective: string;
		let current: EffectiveReviewer | undefined;
		try {
			current = resolveReviewer(settings, state.selection, lookupModels);
			effective = describeReviewer(current);
		} catch (error) {
			effective = `unavailable: ${(error as Error).message}`;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(`Automatic review: ${effective}`, "info");
			return;
		}
		const changeModel = "Change reviewer model";
		const changeEffort = "Change reviewer effort";
		const reset = "Inherit both (clear this session's choice)";
		const action = await ctx.ui.select(`Automatic review: ${effective}`, [changeModel, changeEffort, reset]);
		if (action === undefined) return;
		let next: Selection = { model: state.selection?.model ?? null, effort: state.selection?.effort ?? null };
		if (action === reset) {
			next = { model: null, effort: null };
		} else if (action === changeModel) {
			const inherit = "Inherit (settings, else the session model)";
			const keys = lookupModels.list().map(modelKey);
			const picked = await ctx.ui.select("Reviewer model", [inherit, ...keys]);
			if (picked === undefined) return;
			next.model = picked === inherit ? null : picked;
		} else {
			const model = current?.model;
			if (!model) {
				ctx.ui.notify("Choose an available reviewer model first.", "warning");
				return;
			}
			const inherit = "Inherit (settings, else default)";
			const picked = await ctx.ui.select(`Reviewer effort for ${modelKey(model)}`, [inherit, ...supportedEfforts(model)]);
			if (picked === undefined) return;
			next.effort = picked === inherit ? null : picked;
		}
		try {
			resolveReviewer(settings, next.model || next.effort ? next : undefined, lookupModels);
		} catch (error) {
			ctx.ui.notify(`Not changed: ${(error as Error).message}`, "error");
			return;
		}
		state.setSelection(next.model || next.effort ? next : undefined);
		await showStatus(ctx);
		ctx.ui.notify(`Automatic review now uses ${describeReviewer(resolveReviewer(settings, state.selection, lookupModels))}`, "info");
	}

}
