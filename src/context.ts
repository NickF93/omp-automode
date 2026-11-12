/**
 * Evidence capture, trust labelling, budgeting and request rendering.
 *
 * Raw branch entries are the authority: compaction summaries, assistant text,
 * tool output, skill bodies, delegated tasks and plan content are untrusted.
 * Trusted instructions are kept complete and in source order; only older ones
 * may be shortened, and only as the last recovery step before the request is
 * declared too large.
 */
import type { Api, ImageContent, Message, Model, TextContent, Tool, UserMessage } from "@oh-my-pi/pi-ai";
import {
	ASSISTANT_AGGREGATE_MAX_TOKENS,
	ASSISTANT_ENTRY_MAX_TOKENS,
	BYTES_PER_TOKEN,
	ENVIRONMENT_TEXT,
	FALLBACK_CONTEXT_WINDOW,
	IMAGE_TOKENS,
	INVESTIGATION_TOOLS_TEXT,
	MIN_SHORTENED_TOKENS,
	PRIOR_REVIEW_MAX_TOKENS,
	PRIOR_REVIEWS_MAX,
	PRIOR_REVIEWS_REMINDER,
	RECENT_NON_USER_ENTRIES,
	REQUEST_MARGIN_TOKENS,
	TOOL_AGGREGATE_MAX_TOKENS,
	TOOL_ENTRY_MAX_TOKENS,
	TRUNCATION_MARKER,
} from "./policy";
import { canonicalJson, ENTRY_TYPE, isRecord } from "./state";

// ---------------------------------------------------------------------------
// Text measurement and shortening
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteLength(text: string): number {
	return encoder.encode(text).byteLength;
}

/** Approximate tokens: UTF-8 bytes / 4, rounded up. */
export function estimateTokens(text: string): number {
	return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}

/**
 * Keep the start and end of `text` within `maxBytes`, cutting only on UTF-8
 * character boundaries and marking the cut. Never slices silently.
 */
export function truncateMiddle(text: string, maxBytes: number): string {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	const marker = encoder.encode(`\n${TRUNCATION_MARKER}\n`);
	const budget = Math.max(0, maxBytes - marker.byteLength);
	let headEnd = Math.floor(budget / 2);
	while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 0xc0) === 0x80) headEnd--;
	let tailStart = bytes.byteLength - (budget - headEnd);
	while (tailStart < bytes.byteLength && ((bytes[tailStart] ?? 0) & 0xc0) === 0x80) tailStart++;
	return `${decoder.decode(bytes.subarray(0, headEnd))}\n${TRUNCATION_MARKER}\n${decoder.decode(bytes.subarray(tailStart))}`;
}

// ---------------------------------------------------------------------------
// Evidence model
// ---------------------------------------------------------------------------

/** Priority classes for optional evidence, evicted in this order. */
export type OptionalClass = "tool_description" | "commentary" | "tool" | "image";
export const EVICTION_ORDER: readonly OptionalClass[] = ["tool_description", "commentary", "tool", "image"];

export interface TrustedInstruction {
	/** Where the text comes from, shown to the reviewer. */
	source: string;
	text: string;
}

export interface TranscriptEntry {
	cls: OptionalClass;
	label: string;
	text: string;
	image?: ImageContent;
}

export interface EvidenceSnapshot {
	trusted: TrustedInstruction[];
	transcript: TranscriptEntry[];
	priorReviews: string[];
	omittedEntries: number;
	/** Identity of the trusted instructions, to detect authorization changes during a review. */
	trustFingerprint: string;
}

/** Session entry fields this module reads; shapes are checked at runtime. */
export interface RawEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	details?: unknown;
	attribution?: unknown;
	summary?: unknown;
	mode?: unknown;
}

export interface CaptureOptions {
	/** Subagent sessions: their own user-role entries are delegated, not human, instructions. */
	isChild: boolean;
	/** AGENTS.md context the host rendered into this session's system prompt. */
	agentsContext?: string;
	/** Trusted context inherited from the root session (children only). */
	inherited: TrustedInstruction[];
	/** Plans the user adopted through native plan review. */
	adoptedPlans: TrustedInstruction[];
	/** Explicit plugin-dialog approvals applying to this review. */
	approvals: TrustedInstruction[];
}

function contentParts(content: unknown): { text: string; images: ImageContent[] } {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return { text: texts.join("\n"), images };
}

interface Collected {
	trusted: TrustedInstruction[];
	nonUser: TranscriptEntry[];
	priorReviews: string[];
}

const SKILL_PROMPT_TYPE = "skill-prompt";

/** Walk the raw active branch and label every piece of evidence. */
function collect(branch: readonly RawEntry[], options: CaptureOptions): Collected {
	const trusted: TrustedInstruction[] = [];
	const nonUser: TranscriptEntry[] = [];
	const priorReviews: string[] = [];
	const askQuestions = new Map<string, string>();
	const pushTool = (label: string, text: string) => {
		if (text.trim()) nonUser.push({ cls: "tool", label, text: truncateMiddle(text, TOOL_ENTRY_MAX_TOKENS * BYTES_PER_TOKEN) });
	};
	const pushImages = (label: string, images: ImageContent[]) => {
		for (const image of images) nonUser.push({ cls: "image", label, text: `[image ${image.mimeType}]`, image });
	};

	for (const entry of branch) {
		if (entry.type === "message" && isRecord(entry.message)) {
			const msg = entry.message;
			const { text, images } = contentParts(msg.content);
			switch (msg.role) {
				case "user": {
					const human = !options.isChild && msg.attribution !== "agent" && msg.synthetic !== true;
					if (human) {
						if (text.trim()) trusted.push({ source: "user message", text });
						pushImages("image attached by the user", images);
					} else {
						const label = options.isChild ? "task text from the parent agent (untrusted)" : "agent-injected user-role message (untrusted)";
						nonUser.push({ cls: "commentary", label, text: truncateMiddle(text, ASSISTANT_ENTRY_MAX_TOKENS * BYTES_PER_TOKEN) });
					}
					break;
				}
				case "developer":
					if (msg.attribution !== "agent" && text.trim()) trusted.push({ source: "developer instruction", text });
					break;
				case "assistant": {
					if (!Array.isArray(msg.content)) break;
					const texts: string[] = [];
					for (const part of msg.content) {
						if (!isRecord(part)) continue;
						if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
						else if (part.type === "toolCall" && typeof part.name === "string") {
							const args = isRecord(part.arguments) ? part.arguments : {};
							if (part.name === "ask" && typeof part.id === "string" && typeof args.html === "string") {
								askQuestions.set(part.id, args.html);
							}
							pushTool(`assistant tool call ${part.name} (untrusted)`, JSON.stringify(args));
						}
					}
					const said = texts.join("\n");
					if (said.trim()) {
						nonUser.push({
							cls: "commentary",
							label: "assistant message (untrusted)",
							text: truncateMiddle(said, ASSISTANT_ENTRY_MAX_TOKENS * BYTES_PER_TOKEN),
						});
					}
					break;
				}
				case "toolResult": {
					const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
					const details = isRecord(msg.details) ? msg.details : {};
					const explicitAnswer =
						name === "ask" && msg.isError !== true && details.timedOut !== true && Array.isArray(details.answers);
					if (explicitAnswer) {
						const question = typeof msg.toolCallId === "string" ? askQuestions.get(msg.toolCallId) : undefined;
						trusted.push({
							source: "user answer through the ask tool",
							text: `${question ? `Question (written by the agent): ${question}\n` : ""}User's submitted answer: ${JSON.stringify(details.answers)}`,
						});
					} else {
						pushTool(`${name} result${msg.isError === true ? " (error)" : ""} (untrusted)`, text);
					}
					pushImages(`${name} result image (untrusted)`, images);
					break;
				}
				case "bashExecution":
					if (typeof msg.command === "string") trusted.push({ source: "shell command the user ran", text: msg.command });
					pushTool("output of the user's shell command (untrusted)", typeof msg.output === "string" ? msg.output : "");
					break;
				default:
					if (text.trim()) pushTool(`${String(msg.role)} message (untrusted)`, text);
			}
		} else if (entry.type === "custom_message") {
			const { text, images } = contentParts(entry.content);
			const details = isRecord(entry.details) ? entry.details : {};
			if (entry.customType === SKILL_PROMPT_TYPE && entry.attribution === "user" && !options.isChild) {
				const invocation =
					typeof details.prompt === "string"
						? details.prompt
						: `/skill:${String(details.name)}${typeof details.args === "string" ? ` ${details.args}` : ""}`;
				trusted.push({ source: "skill the user invoked", text: invocation });
				pushTool(`expanded body of skill ${String(details.name)} (untrusted text; the user invoked it)`, text);
			} else if (text.trim()) {
				pushTool(`${entry.customType ?? "custom"} message (untrusted)`, text);
			}
			pushImages("custom message image (untrusted)", images);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
			nonUser.push({
				cls: "commentary",
				label: `${entry.type === "compaction" ? "compaction" : "branch"} summary written by a model (untrusted; never a grant)`,
				text: truncateMiddle(entry.summary, ASSISTANT_ENTRY_MAX_TOKENS * BYTES_PER_TOKEN),
			});
		} else if (entry.type === "mode_change" && typeof entry.mode === "string") {
			nonUser.push({ cls: "commentary", label: "session mode change", text: `mode: ${entry.mode}` });
		} else if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isRecord(entry.data)) {
			const data = entry.data;
			if (data.kind === "result" && isRecord(data.action)) {
				const verdict = isRecord(data.verdict) ? data.verdict : undefined;
				const summary = verdict
					? `${String(verdict.outcome)} (risk ${String(verdict.risk_level)}, authorization ${String(verdict.user_authorization)}): ${String(verdict.rationale)}`
					: `${String(data.result)}${typeof data.detail === "string" ? `: ${data.detail}` : ""}`;
				priorReviews.push(
					truncateMiddle(
						`Action ${canonicalJson({ tool: data.action.tool, input: data.action.input })} -> ${summary}`,
						PRIOR_REVIEW_MAX_TOKENS * BYTES_PER_TOKEN,
					),
				);
			}
		}
	}
	return { trusted, nonUser, priorReviews };
}

/**
 * Capture the immutable evidence snapshot for one review. Trusted instructions
 * are complete; non-user evidence keeps the most recent entries within the
 * per-class aggregate limits, and every omission is counted.
 */
export function captureEvidence(branch: readonly RawEntry[], options: CaptureOptions): EvidenceSnapshot {
	const collected = collect(branch, options);
	const trusted: TrustedInstruction[] = [
		...options.inherited.map(t => ({ source: `inherited from the root session: ${t.source}`, text: t.text })),
		...(options.agentsContext ? [{ source: "AGENTS.md context supplied by the host", text: options.agentsContext }] : []),
		...collected.trusted,
		...options.adoptedPlans,
		...options.approvals,
	];
	const recent = collected.nonUser.slice(-RECENT_NON_USER_ENTRIES);
	let omitted = collected.nonUser.length - recent.length;
	const used: Record<"commentary" | "tool", number> = { commentary: 0, tool: 0 };
	const limits: Record<"commentary" | "tool", number> = {
		commentary: ASSISTANT_AGGREGATE_MAX_TOKENS,
		tool: TOOL_AGGREGATE_MAX_TOKENS,
	};
	const kept: TranscriptEntry[] = [];
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i] as TranscriptEntry;
		if (entry.cls === "commentary" || entry.cls === "tool") {
			const tokens = estimateTokens(entry.text);
			if (used[entry.cls] + tokens > limits[entry.cls]) {
				omitted++;
				continue;
			}
			used[entry.cls] += tokens;
		}
		kept.unshift(entry);
	}
	return {
		trusted,
		transcript: kept,
		priorReviews: collected.priorReviews.slice(-PRIOR_REVIEWS_MAX),
		omittedEntries: omitted,
		trustFingerprint: canonicalJson(trusted),
	};
}

// ---------------------------------------------------------------------------
// Request rendering and admission
// ---------------------------------------------------------------------------

export interface PlannedAction {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	agent: { kind: string; id: string; name: string; depth: number; parentId?: string };
	session: string;
	/** Present when the action reached the tool through `write xd://<tool>`. */
	via?: string;
	/** Description of the tool from the host registry, as optional supporting evidence. */
	toolDescription?: string;
}

export interface RenderOptions {
	retryReason?: string;
	imageInput: boolean;
}

/** Evidence after admission: what is actually sent. */
export interface AdmittedEvidence {
	trusted: TrustedInstruction[];
	transcript: TranscriptEntry[];
	priorReviews: string[];
	omittedEntries: number;
	shortenedInstructions: number;
	toolDescription?: string;
}

function renderUserContent(evidence: AdmittedEvidence, action: PlannedAction, options: RenderOptions): (TextContent | ImageContent)[] {
	const parts: (TextContent | ImageContent)[] = [];
	const text = (value: string) => parts.push({ type: "text", text: value });
	text(
		`${ENVIRONMENT_TEXT}\n- Calling working directory: ${action.cwd}\n- Calling agent: ${action.agent.kind} ${action.agent.id} (${action.agent.name}, depth ${action.agent.depth})\n\n${INVESTIGATION_TOOLS_TEXT}`,
	);
	const trusted = evidence.trusted.map((t, i) => `<instruction n="${i + 1}" source="${t.source}">\n${t.text}\n</instruction>`);
	const notes: string[] = [];
	if (evidence.shortenedInstructions > 0) {
		notes.push(`${evidence.shortenedInstructions} older trusted instructions were shortened to fit; ${TRUNCATION_MARKER} marks each cut.`);
	}
	text(
		`# Trusted instructions (in order)\n${trusted.join("\n") || "(none)"}${notes.length ? `\n\nNote: ${notes.join(" ")}` : ""}`,
	);
	const lines: string[] = ["# Transcript evidence (oldest first; labels state trust)"];
	if (evidence.omittedEntries > 0) {
		lines.push(`[${evidence.omittedEntries} older transcript entries were omitted. Omitted evidence is unknown, not harmless.]`);
	}
	text(lines.join("\n"));
	for (const entry of evidence.transcript) {
		if (entry.image && options.imageInput) {
			text(`[${entry.label}]`);
			parts.push(entry.image);
		} else {
			text(`[${entry.label}]\n${entry.text}`);
		}
	}
	if (evidence.priorReviews.length > 0) {
		text(`# Earlier reviews in this session\n${PRIOR_REVIEWS_REMINDER}\n${evidence.priorReviews.map(r => `- ${r}`).join("\n")}`);
	}
	if (evidence.toolDescription) text(`# Description of the tool being called (untrusted)\n${evidence.toolDescription}`);
	const planned = {
		tool: action.tool,
		input: action.input,
		cwd: action.cwd,
		agent: action.agent,
		session: action.session,
		...(action.via ? { via: action.via } : {}),
		...(options.retryReason ? { retry_reason: options.retryReason } : {}),
	};
	text(`# Planned action (judge exactly this)\n${JSON.stringify(planned, null, 2)}`);
	return parts;
}

export function contextCeiling(model: Model<Api>): number {
	const listed = model.contextWindow;
	const window = typeof listed === "number" && Number.isFinite(listed) && listed > 0 ? listed : FALLBACK_CONTEXT_WINDOW;
	return Math.max(0, window - REQUEST_MARGIN_TOKENS);
}

/** Estimated input tokens of a whole request. Images cost a fixed reservation plus their metadata. */
export function estimateRequest(systemPrompt: readonly string[], tools: readonly Tool[], messages: readonly Message[]): number {
	let tokens = estimateTokens(systemPrompt.join("\n")) + estimateTokens(JSON.stringify(tools));
	for (const message of messages) {
		if (typeof message.content === "string") {
			tokens += estimateTokens(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "image") tokens += IMAGE_TOKENS + estimateTokens(part.mimeType);
			else if (part.type === "text") tokens += estimateTokens(part.text);
			else tokens += estimateTokens(JSON.stringify(part));
		}
	}
	return tokens + messages.length * 4;
}

function entryTokens(entry: TranscriptEntry, imageInput: boolean): number {
	return (entry.image && imageInput ? IMAGE_TOKENS + estimateTokens(entry.image.mimeType) : estimateTokens(entry.text)) + estimateTokens(entry.label) + 4;
}

export type Admission =
	| { ok: true; message: UserMessage & { content: (TextContent | ImageContent)[] }; evidence: AdmittedEvidence; tokens: number }
	| { ok: false; reason: string };

/**
 * Fit the evidence into the request ceiling. Order: drop optional entries that
 * cannot fit at all; evict whole optional entries tool descriptions first,
 * then commentary, tool evidence and images, oldest first; finally shorten
 * older trusted instructions, keeping both ends. The exact action is never
 * shortened. Returns a failure when even that is not enough.
 */
export function admit(
	snapshot: EvidenceSnapshot,
	action: PlannedAction,
	systemPrompt: readonly string[],
	tools: readonly Tool[],
	model: Model<Api>,
	options: RenderOptions,
	privateHistoryTokens = 0,
): Admission {
	const ceiling = contextCeiling(model);
	const evidence: AdmittedEvidence = {
		trusted: snapshot.trusted.map(t => ({ ...t })),
		transcript: [...snapshot.transcript],
		priorReviews: [...snapshot.priorReviews],
		omittedEntries: snapshot.omittedEntries,
		shortenedInstructions: 0,
		toolDescription: action.toolDescription
			? truncateMiddle(action.toolDescription, TOOL_ENTRY_MAX_TOKENS * BYTES_PER_TOKEN)
			: undefined,
	};
	const measure = () => {
		const message = { role: "user" as const, content: renderUserContent(evidence, action, options), timestamp: Date.now() };
		return { message, tokens: estimateRequest(systemPrompt, tools, [message]) + privateHistoryTokens };
	};
	let current = measure();
	if (current.tokens <= ceiling) return { ok: true, ...current, evidence };

	// Required size: everything except optional evidence.
	const optionalTokens =
		evidence.transcript.reduce((sum, e) => sum + entryTokens(e, options.imageInput), 0) +
		(evidence.toolDescription ? estimateTokens(evidence.toolDescription) : 0);
	const room = ceiling - (current.tokens - optionalTokens);
	const before = evidence.transcript.length;
	evidence.transcript = evidence.transcript.filter(e => entryTokens(e, options.imageInput) <= room);
	evidence.omittedEntries += before - evidence.transcript.length;
	if (evidence.toolDescription && estimateTokens(evidence.toolDescription) > room) evidence.toolDescription = undefined;
	current = measure();

	for (const cls of EVICTION_ORDER) {
		if (current.tokens <= ceiling) break;
		if (cls === "tool_description") {
			if (evidence.toolDescription) {
				evidence.toolDescription = undefined;
				current = measure();
			}
			continue;
		}
		while (current.tokens > ceiling) {
			const index = evidence.transcript.findIndex(e => e.cls === cls);
			if (index < 0) break;
			// Estimate locally, then re-measure once per batch to stay linear.
			let excess = current.tokens - ceiling;
			let i = index;
			while (i < evidence.transcript.length && excess > 0) {
				const entry = evidence.transcript[i] as TranscriptEntry;
				if (entry.cls === cls) {
					excess -= entryTokens(entry, options.imageInput);
					evidence.transcript.splice(i, 1);
					evidence.omittedEntries++;
				} else {
					i++;
				}
			}
			current = measure();
		}
	}
	if (current.tokens <= ceiling) return { ok: true, ...current, evidence };

	// Last step: shorten older trusted instructions, oldest first, never the newest.
	for (let i = 0; i < evidence.trusted.length - 1 && current.tokens > ceiling; i++) {
		const item = evidence.trusted[i] as TrustedInstruction;
		const original = item.text;
		let target = estimateTokens(original);
		while (current.tokens > ceiling && target > MIN_SHORTENED_TOKENS) {
			target = Math.max(MIN_SHORTENED_TOKENS, target - (current.tokens - ceiling));
			if (item.text === original) evidence.shortenedInstructions++;
			item.text = truncateMiddle(original, target * BYTES_PER_TOKEN);
			current = measure();
		}
	}
	if (current.tokens <= ceiling) return { ok: true, ...current, evidence };
	return {
		ok: false,
		reason: `about ${current.tokens} tokens needed, ${ceiling} available for ${model.provider}/${model.id}`,
	};
}
