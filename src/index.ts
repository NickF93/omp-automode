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
import { completions, describeReviewer, parseSubcommand, renderShow, USAGE, valueSource } from "./commands";
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
	applyOverrides,
	type AutoReviewSettings,
	type EffectiveReviewer,
	loadSettings,
	loadSnapshot,
	type ModelLookup,
	modelKey,
	NO_OVERRIDES,
	OVERRIDE_KEYS,
	type OverrideKey,
	parseRules,
	parseSettings,
	parseTimeout,
	releaseHostDeadline,
	requireHostDeadline,
	resolveReviewer,
	saveUserSettings,
	type SessionOverrides,
	SettingsError,
	type SettingsSnapshot,
	supportedEfforts,
} from "./settings";
import { type ActionKey, canonicalJson, type ResultEntry, SessionState } from "./state";

const STATUS_KEY = "omp-automode";

// ---------------------------------------------------------------------------
// Root-to-child lineage. Only real host parent identities link here.
// ---------------------------------------------------------------------------

/** What a session passes to its subagents: trusted instructions, on/off and session overrides. */
interface Control {
	enabled: boolean;
	overrides: SessionOverrides | undefined;
}

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

function inheritedFor(ctx: ExtensionContext): TrustedInstruction[] {
	return parentLineage(ctx)?.trusted() ?? [];
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

function modelLookup(ctx: ExtensionContext, pi: ExtensionAPI): ModelLookup {
	return {
		resolve: spec => ctx.models.resolve(spec),
		list: () => ctx.models.list(),
		current: () => ctx.model,
		currentEffort: () => pi.getThinkingLevel(),
	};
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
		inherited: inheritedFor(ctx),
		approvals,
	});

	/** A subagent follows its parent's switch and overrides; a root session uses its own. */
	const control = (ctx: ExtensionContext): Control =>
		parentLineage(ctx)?.control() ?? { enabled: state.enabled, overrides: state.overrides };

	/** Settings with this session's overrides applied. */
	const effectiveSettings = async (ctx: ExtensionContext): Promise<AutoReviewSettings> =>
		applyOverrides(await loadSettings(ctx.cwd), control(ctx).overrides);

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
	const applyDeadline = (ctx: ExtensionContext, timeoutMs: number) => {
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
			applyDeadline(ctx, (await effectiveSettings(ctx)).timeoutMs);
		} catch {
			// Invalid settings block every reviewed call with their own reason.
		}
	};

	const restore = (ctx: ExtensionContext) => {
		cancelInflight();
		state.replay(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		const sessionManager = ctx.sessionManager;
		const snapshotCtx = ctx;
		if (agentId !== undefined && lineage) lineageByAgent.get(agentId)?.delete(lineage);
		agentId = ctx.agent.id;
		lineage = {
			trusted: () => captureEvidence(sessionManager.getBranch(), captureOptions(snapshotCtx, [])).trusted,
			control: () => control(snapshotCtx),
		};
		const lineages = lineageByAgent.get(agentId) ?? new Set();
		lineages.add(lineage);
		lineageByAgent.set(agentId, lineages);
		await ensureDeadline(ctx);
		await showStatus(ctx);
		warnIfOff(ctx);
	});
	const onTransition = async (_event: unknown, ctx: ExtensionContext) => {
		restore(ctx);
		await ensureDeadline(ctx);
		await showStatus(ctx);
		warnIfOff(ctx);
	};
	pi.on("session_switch", onTransition);
	pi.on("session_branch", onTransition);
	pi.on("session_tree", onTransition);
	pi.on("session_shutdown", () => {
		cancelInflight();
		state.expireLive();
		if (deadlineSettings && deadlineOwner) releaseHostDeadline(deadlineSettings, deadlineOwner);
		deadlineSettings = undefined;
		if (agentId !== undefined && lineage) {
			const lineages = lineageByAgent.get(agentId);
			lineages?.delete(lineage);
			if (lineages?.size === 0) lineageByAgent.delete(agentId);
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
		applyDeadline(ctx, settings.timeoutMs);
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
		return runReview(ctx, settings, overrides, {
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
		description: "Automatic review: show, config, on, off, approve, save",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => autoReviewCommand(args, ctx),
	});

	pi.registerCommand("approve", {
		description: "Alias of /auto-review approve: approve one reviewed retry of a recently denied action",
		handler: async (_args, ctx) => approveCommand(ctx),
	});

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
				await ensureDeadline(ctx);
				await showStatus(ctx);
				return showCommand(ctx);
		}
	}

	/** A restored or resumed root session that is off says so; its subagents follow it silently. */
	function warnIfOff(ctx: ExtensionContext): void {
		if (ctx.agent.kind === "sub" || state.enabled) return;
		ctx.ui.notify(
			"Automatic review is OFF for this session: tool calls run without review. /auto-review on turns it back on.",
			"warning",
		);
	}

	async function readSnapshot(ctx: ExtensionContext): Promise<SettingsSnapshot | undefined> {
		try {
			return await loadSnapshot(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Could not read omp-automode settings: ${(error as Error).message}`, "error");
			return undefined;
		}
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
			ctx.ui.notify("/auto-review config needs interactive dialogs; use omp plugin config set omp-automode <key> <value>.", "error");
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
		await ensureDeadline(ctx);
		await showStatus(ctx);
		const changed = OVERRIDE_KEYS.filter(k => state.overrides && state.overrides[k] !== null);
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
		await ensureDeadline(ctx);
		await showStatus(ctx);
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
		ctx.ui.notify(
			"Automatic review is OFF for this session: tool calls run without review. /auto-review on turns it back on.",
			"warning",
		);
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
		const keys = OVERRIDE_KEYS.filter(key => overrides[key] !== null);
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
}
