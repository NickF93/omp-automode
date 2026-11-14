/**
 * Review-loop behavior against a scripted in-process model registered as a
 * custom API. This is controlled fault injection for retry, deadline, parse,
 * overflow and sandbox boundaries; it is not a production verdict.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
	type ToolResultMessage,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai";
import { Flag } from "@oh-my-pi/pi-ai/error";
import type { EvidenceSnapshot, PlannedAction } from "../src/context";
import { verdictPolicyError } from "../src/policy";
import { AUTHORIZATIONS, RISK_LEVELS, type Verdict } from "../src/state";
import { isRetryableResponse, parseVerdict, type ReviewRequest, review, VerdictParseError } from "../src/reviewer";

const API = "omp-automode-test";
const FIXTURES = path.join(import.meta.dir, "..", ".test-tmp");

type Step = (context: Context, options: SimpleStreamOptions | undefined) => Partial<AssistantMessage> | "hang";
let script: Step[] = [];
const seen: Context[] = [];

function reply(over: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: "test",
		model: "scripted",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...over,
	} as AssistantMessage;
}

const text = (t: string): Partial<AssistantMessage> => ({ content: [{ type: "text", text: t }] });
const complete = (over: Partial<Verdict> = {}) => text(JSON.stringify({
	outcome: "allow",
	risk_level: "low",
	user_authorization: "unknown",
	rationale: "Removes the requested local cleanup target; no additional trusted authorization was supplied.",
	...over,
}));
const failure = (errorStatus: number | undefined, errorId?: number, errorMessage = "boom"): Partial<AssistantMessage> => ({
	stopReason: "error",
	errorStatus,
	errorId,
	errorMessage,
});
const toolCall = (name: string, args: Record<string, unknown>, id = crypto.randomUUID()): Partial<AssistantMessage> => ({
	stopReason: "toolUse",
	content: [{ type: "toolCall", id, name, arguments: args }],
});

let root: string;

beforeAll(() => {
	// The sandbox mounts a private /tmp, so fixtures it must read live outside /tmp.
	mkdirSync(FIXTURES, { recursive: true });
	root = mkdtempSync(path.join(FIXTURES, "review-"));
	writeFileSync(path.join(root, "target.txt"), "precious data\n");
	registerCustomApi(
		API,
		(_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			seen.push(structuredClone(context));
			const step = script.shift();
			queueMicrotask(() => {
				const result = step ? step(context, options) : complete();
				if (result === "hang") {
					options?.signal?.addEventListener("abort", () =>
						stream.push({ type: "error", reason: "aborted", error: reply({ stopReason: "aborted" }) }),
					);
					return;
				}
				const message = reply(result);
				if (message.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: message });
					return;
				}
				// Providers report tool calls through events; the final message alone does not carry them.
				stream.push({ type: "start", partial: message });
				message.content.forEach((part, contentIndex) => {
					if (part.type !== "toolCall") return;
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(part.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
				});
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		},
		"test",
	);
});

afterAll(() => {
	unregisterCustomApis("test");
	rmSync(root, { recursive: true, force: true });
});

/** Minimal catalogue model routed to the scripted API. */
function scriptedModel(contextWindow = 200_000): Model<Api> {
	return { provider: "test", id: "scripted", api: API, contextWindow, input: ["text"], reasoning: false } as unknown as Model<Api>;
}

const action = (): PlannedAction => ({
	tool: "bash",
	input: { command: `rm ${path.join(root, "target.txt")}` },
	cwd: root,
	agent: { kind: "main", id: "Main", name: "main", depth: 0 },
	session: "s",
});

const snapshot = (fingerprint = "f"): EvidenceSnapshot => ({
	trusted: [{ source: "user message", text: "clean up" }],
	transcript: [],
	priorReviews: [],
	omittedEntries: 0,
	trustFingerprint: fingerprint,
});

function request(over: Partial<ReviewRequest> = {}): ReviewRequest {
	return {
		model: scriptedModel(),
		effort: undefined,
		timeoutMs: 10_000,
		instructions: "policy",
		action: action(),
		capture: () => snapshot(),
		apiKey: "test-key",
		sessionId: "s:auto-review",
		signal: new AbortController().signal,
		...over,
	};
}

async function run(steps: Step[], over: Partial<ReviewRequest> = {}) {
	script = steps;
	seen.length = 0;
	return review(request(over));
}

describe("verdict parsing", () => {
	const valid = { outcome: "allow", risk_level: "low", user_authorization: "unknown", rationale: "  Reads local status; no trusted approval was supplied.  " } as const;

	test("complete low/unknown assessment is retained, trimmed and stripped of extra fields", () => {
		expect(parseVerdict(JSON.stringify({ ...valid, extra: "ignored" }))).toEqual({
			...valid,
			rationale: valid.rationale.trim(),
		});
	});

	for (const outcome of ["allow", "deny"]) {
		for (const field of ["outcome", "risk_level", "user_authorization", "rationale"]) {
			test(`${outcome}: ${field} must be explicitly supplied with the right type`, () => {
				const base: Record<string, unknown> = { ...valid, outcome };
				const missing = { ...base };
				delete missing[field];
				const error = field === "rationale" ? "rationale must be a nonblank string"
					: field === "outcome" ? "reviewer answer has no valid outcome" : `missing or invalid ${field}`;
				for (const value of [missing, { ...base, [field]: null }, { ...base, [field]: 5 }, { ...base, [field]: {} }]) {
					expect(() => parseVerdict(JSON.stringify(value))).toThrow(error);
				}
			});
		}
		test(`${outcome}: blank rationales are rejected`, () => {
			for (const rationale of ["", " \n\t "]) {
				expect(() => parseVerdict(JSON.stringify({ ...valid, outcome, rationale }))).toThrow("rationale must be a nonblank string");
			}
		});
	}

	test.each([
		["prose", "I think this is fine"],
		["malformed JSON", "{bad"],
		["wrapped object", `Here you go: ${JSON.stringify(valid)} thanks`],
		["fenced object", `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``],
		["trailing object", `${JSON.stringify(valid)} {}`],
	])("%s is not strict JSON", (_name, raw) => {
		expect(() => parseVerdict(raw)).toThrow("reviewer answer was not valid JSON");
	});

	test.each(["[]", "null", "true", "1", '"allow"'])("%s is not an object", raw => {
		expect(() => parseVerdict(raw)).toThrow("reviewer answer was not a JSON object");
	});

	test.each([
		["outcome", "maybe"], ["risk_level", "tiny"], ["user_authorization", "yes"],
	])("invalid %s enum fails", (field, value) => {
		expect(() => parseVerdict(JSON.stringify({ ...valid, [field]: value }))).toThrow(VerdictParseError);
	});
});

describe("mandatory verdict policy floor", () => {
	for (const risk_level of RISK_LEVELS) {
		for (const user_authorization of AUTHORIZATIONS) {
			for (const outcome of ["allow", "deny"] as const) {
				test(`${risk_level}/${user_authorization}/${outcome}`, () => {
					const error = outcome === "deny" ? undefined
						: risk_level === "critical" ? "critical risk cannot be allowed"
						: risk_level === "high" && (user_authorization === "low" || user_authorization === "unknown")
							? "high risk requires medium or high authorization" : undefined;
					expect(verdictPolicyError({ risk_level, user_authorization, outcome })).toBe(error);
				});
			}
		}
	}
});

describe("retry classification", () => {
	test("408, 429 and 5xx are transient; other statuses are not", () => {
		expect([408, 429, 500, 503].map(s => isRetryableResponse({ errorStatus: s, errorId: undefined }))).toEqual([true, true, true, true]);
		expect([400, 401, 404].map(s => isRetryableResponse({ errorStatus: s, errorId: undefined }))).toEqual([false, false, false]);
	});

	test("without a status only a positively classified transient failure retries", () => {
		expect(isRetryableResponse({ errorStatus: undefined, errorId: Flag.Transient })).toBe(true);
		expect(isRetryableResponse({ errorStatus: undefined, errorId: undefined })).toBe(false);
		expect(isRetryableResponse({ errorStatus: undefined, errorId: Flag.Transient | Flag.AuthFailed })).toBe(false);
	});
});

describe("review attempts", () => {
	test("a direct verdict completes in one attempt", async () => {
		const result = await run([() => complete()]);
		expect(result.kind).toBe("verdict");
		expect(result.stats).toMatchObject({ attempts: 1, samplingRequests: 1, checkpointRestarts: 0 });
	});

	test("compact allow retries and returns only the corrected complete assessment", async () => {
		const result = await run([() => text('{"outcome":"allow"}'), () => complete({ rationale: "Removes regenerable scratch output; trusted instructions request cleanup." })]);
		expect(result).toMatchObject({
			kind: "verdict",
			verdict: { risk_level: "low", user_authorization: "unknown", rationale: "Removes regenerable scratch output; trusted instructions request cleanup." },
			stats: { attempts: 2 },
		});
		expect(JSON.stringify(seen[1])).toContain("missing or invalid risk_level");
	});

	test("three compact answers fail technically without fabricating a denial", async () => {
		const result = await run(Array.from({ length: 3 }, () => () => text('{"outcome":"allow"}')));
		expect(result).toMatchObject({ kind: "failure", stats: { attempts: 3, samplingRequests: 3 } });
		expect(result).not.toHaveProperty("verdict");
	});

	test.each([
		["critical", "high", "critical risk cannot be allowed"],
		["high", "unknown", "high risk requires medium or high authorization"],
		["high", "low", "high risk requires medium or high authorization"],
	] as const)("%s/%s allow retries with a sanitized policy error", async (risk_level, user_authorization, error) => {
		const rejected = { risk_level, user_authorization, rationale: "PRIVATE-REJECTED-REPLY-MARKER" };
		const corrected = await run([
			() => complete(rejected),
			() => complete({ outcome: "deny", risk_level, user_authorization, rationale: "The action would expose protected data without sufficient trusted approval." }),
		]);
		expect(corrected).toMatchObject({ kind: "verdict", verdict: { outcome: "deny", risk_level, user_authorization }, stats: { attempts: 2 } });
		expect(JSON.stringify(seen[1])).toContain(error);
		expect(JSON.stringify(seen[1])).not.toContain(rejected.rationale);
		const failed = await run(Array.from({ length: 3 }, () => () => complete(rejected)));
		expect(failed).toMatchObject({ kind: "failure", detail: `${error} after 3 attempts`, stats: { attempts: 3 } });
		expect(failed).not.toHaveProperty("verdict");
	});

	test("invalid field retry feedback names the field without retaining the reply", async () => {
		const result = await run([
			() => text('{"outcome":"allow","rationale":"PRIVATE-MISSING-FIELD-MARKER"}'),
			() => complete(),
		]);
		expect(result.kind).toBe("verdict");
		expect(JSON.stringify(seen[1])).toContain("missing or invalid risk_level");
		expect(JSON.stringify(seen[1])).not.toContain("PRIVATE-MISSING-FIELD-MARKER");
	});

	test.each(["medium", "high"] as const)("high risk with %s authorization remains an allow", async user_authorization => {
		const result = await run([() => complete({ risk_level: "high", user_authorization, rationale: "Merges the bounded reviewed PR into protected main under trusted user approval." })]);
		expect(result).toMatchObject({ kind: "verdict", verdict: { outcome: "allow", risk_level: "high", user_authorization }, stats: { attempts: 1 } });
	});

	test.each(["low", "medium"] as const)("specific %s-risk denials are not rewritten", async risk_level => {
		const result = await run([() => complete({ outcome: "deny", risk_level, user_authorization: "high", rationale: "The user specifically forbids this otherwise routine local write." })]);
		expect(result).toMatchObject({ kind: "verdict", verdict: { outcome: "deny", risk_level }, stats: { attempts: 1 } });
	});

	test("malformed answers retry, up to three attempts", async () => {
		const ok = await run([() => text("hmm"), () => text("{bad"), () => complete({ outcome: "deny", rationale: "Deletes files outside the user's cleanup request." })]);
		expect(ok.kind === "verdict" && ok.verdict.outcome).toBe("deny");
		expect(ok.stats.attempts).toBe(3);
		const failed = await run([() => text("a"), () => text("b"), () => text("c")]);
		expect(failed.kind).toBe("failure");
		expect(failed.stats.attempts).toBe(3);
	});

	test("transient service failures retry; nonretryable and unclassified failures do not", async () => {
		const recovered = await run([() => failure(503), () => complete()]);
		expect(recovered.kind).toBe("verdict");
		expect(recovered.stats.attempts).toBe(2);
		const bad = await run([() => failure(400, undefined, "bad request")]);
		expect(bad.kind === "failure" && bad.detail).toContain("bad request");
		expect(bad.stats.attempts).toBe(1);
		const unknown = await run([() => failure(undefined)]);
		expect(unknown.kind).toBe("failure");
		expect(unknown.stats.attempts).toBe(1);
	});

	// Exercises the real deadline timer: the review owns a wall-clock deadline, so fake time cannot drive it.
	test("the deadline bounds the whole review and reports a timeout, not a denial", async () => {
		const started = Date.now();
		const result = await run([() => "hang"], { timeoutMs: 300 });
		expect(result.kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("requests carry a stall bound of half the deadline unless the catalog sets a stream budget", async () => {
		const bound = async (compat: Record<string, unknown> | undefined) => {
			let options: SimpleStreamOptions | undefined;
			const model = { ...scriptedModel(), ...(compat ? { compat } : {}) } as Model<Api>;
			await run([(_c, o) => ((options = o), complete())], { model, timeoutMs: 90_000 });
			return [options?.streamFirstEventTimeoutMs, options?.streamIdleTimeoutMs];
		};
		expect(await bound(undefined)).toEqual([45_000, 45_000]);
		// Catalog-built models carry both keys even when unset.
		expect(await bound({ streamIdleTimeoutMs: undefined, streamFirstEventTimeoutMs: undefined })).toEqual([45_000, 45_000]);
		expect(await bound({ streamIdleTimeoutMs: 600_000 })).toEqual([undefined, undefined]);
		expect(await bound({ streamFirstEventTimeoutMs: 0 })).toEqual([undefined, undefined]);
	});

	test("an external cancellation reports cancelled", async () => {
		const controller = new AbortController();
		const result = await run(
			[
				() => {
					queueMicrotask(() => controller.abort());
					return "hang";
				},
			],
			{ signal: controller.signal },
		);
		expect(result.kind).toBe("cancelled");
	});

	test("changed trusted instructions during review recapture without counting as a verdict", async () => {
		let fingerprint = "f";
		const result = await run(
			[
				() => {
					fingerprint = "g";
					return complete();
				},
				() => complete({ outcome: "deny", rationale: "Deletes the target after the user revoked permission." }),
			],
			{ capture: () => snapshot(fingerprint) },
		);
		expect(result.kind === "verdict" && result.verdict.outcome).toBe("deny");
		expect(result.stats.attempts).toBe(2);
	});

	test("a request that cannot fit at all is an input-budget result without inference", async () => {
		const result = await run([], { model: scriptedModel(400) });
		expect(result.kind).toBe("input_budget");
		expect(result.stats.samplingRequests).toBe(0);
	});
});

describe("sandboxed investigation", () => {
	test("reviewer reads local state read-only and cannot write or reach the network", async () => {
		const target = path.join(root, "target.txt");
		const result = await run([
			() =>
				toolCall("exec_command", {
					cmd: `cat ${target}; echo overwrite > ${target}; echo "write=$?"; getent hosts example.com; echo "dns=$?"; systemd-run --user --quiet true 2>/dev/null; echo "systemd=$?"; echo "bus=\${DBUS_SESSION_BUS_ADDRESS:-none} agent=\${SSH_AUTH_SOCK:-none} run=$(ls /run | wc -l)"`,
				}),
			context => {
				const last = context.messages.at(-1) as ToolResultMessage;
				const output = last.content.map(p => (p.type === "text" ? p.text : "")).join("");
				expect(output).toContain("precious data");
				expect(output).toContain("write=1");
				expect(output).not.toContain("dns=0");
				expect(output).not.toContain("systemd=0");
				expect(output).toContain("bus=none agent=none run=0");
				return complete({ outcome: "deny", risk_level: "high", rationale: "Deletes user data without trusted approval." });
			},
		]);
		expect(result.kind).toBe("verdict");
		expect(readFileSync(target, "utf8")).toBe("precious data\n");
		expect(result.stats.samplingRequests).toBe(2);
	});

	test("long-running commands continue through write_stdin and are reaped at the end", async () => {
		let sessionId = 0;
		const result = await run([
			() => toolCall("exec_command", { cmd: "read line; echo got:$line", yield_time_ms: 100 }),
			context => {
				const output = JSON.stringify((context.messages.at(-1) as ToolResultMessage).content);
				sessionId = Number(/session_id: (\d+)/.exec(output)?.[1]);
				return toolCall("write_stdin", { session_id: sessionId, chars: "hello\n", yield_time_ms: 2000 });
			},
			context => {
				const output = JSON.stringify((context.messages.at(-1) as ToolResultMessage).content);
				expect(output).toContain("got:hello");
				expect(output).toContain("exit_code: 0");
				return toolCall("exec_command", { cmd: "sleep 30", yield_time_ms: 50 });
			},
			() => complete(),
		]);
		expect(sessionId).toBeGreaterThan(0);
		expect(result.kind).toBe("verdict");
	});

	test("parallel calls in one message run as a batch and wait collects them", async () => {
		const result = await run([
			() => ({
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "a", name: "exec_command", arguments: { cmd: "sleep 0.2; echo one", yield_time_ms: 10 } },
					{ type: "toolCall", id: "b", name: "exec_command", arguments: { cmd: "echo two" } },
				],
			}),
			context => {
				const outputs = context.messages.slice(-2).map(m => JSON.stringify((m as ToolResultMessage).content));
				expect(outputs[1]).toContain("two");
				const id = Number(/session_id: (\d+)/.exec(outputs[0] ?? "")?.[1]);
				return toolCall("wait", { session_ids: [id], timeout_ms: 3000 });
			},
			context => {
				expect(JSON.stringify((context.messages.at(-1) as ToolResultMessage).content)).toContain("one");
				return complete();
			},
		]);
		expect(result.kind).toBe("verdict");
	});

	test("context exhaustion after investigation restarts once from the frozen checkpoint", async () => {
		const result = await run([
			() => toolCall("exec_command", { cmd: "echo look" }),
			() => failure(400, Flag.ContextOverflow, "prompt is too long"),
			() => complete(),
		]);
		expect(result.kind).toBe("verdict");
		expect(result.stats).toMatchObject({ attempts: 1, checkpointRestarts: 1, samplingRequests: 3 });
		const restartedRequest = seen.at(-1) as Context;
		expect(restartedRequest.messages).toHaveLength(1);
	});

	test("investigation history is paid for by trimming optional evidence, keeping the newest step", async () => {
		const bulky = (): EvidenceSnapshot => ({
			...snapshot(),
			transcript: [0, 1, 2].map(i => ({ cls: "tool" as const, label: `old ${i}`, text: String(i).repeat(3600) })),
		});
		const result = await run(
			[
				() => toolCall("exec_command", { cmd: "head -c 3000 /dev/zero | tr '\\0' x" }),
				() => complete(),
			],
			{ model: scriptedModel(4_200), capture: bulky },
		);
		expect(result.kind).toBe("verdict");
		expect(result.stats.checkpointRestarts).toBe(0);
		const last = seen.at(-1) as Context;
		expect(last.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(JSON.stringify(last.messages[0]?.content)).toContain("older transcript entries were omitted");
	});

	test("a server overflow on the first request recovers evidence once against a lower ceiling", async () => {
		const bulky = (): EvidenceSnapshot => ({
			...snapshot(),
			transcript: [0, 1, 2].map(i => ({ cls: "tool" as const, label: `old ${i}`, text: String(i).repeat(3600) })),
		});
		const result = await run([() => failure(400, Flag.ContextOverflow), () => complete()], { capture: bulky });
		expect(result.kind).toBe("verdict");
		expect(JSON.stringify((seen.at(-1) as Context).messages[0]?.content)).toContain("older transcript entries were omitted");
		const twice = await run([() => failure(400, Flag.ContextOverflow), () => failure(400, Flag.ContextOverflow)]);
		expect(twice.kind).toBe("input_budget");
	});

	test("repeated exhaustion after the one restart ends as input budget", async () => {
		const result = await run([
			() => toolCall("exec_command", { cmd: "echo look" }),
			() => failure(400, Flag.ContextOverflow),
			() => toolCall("exec_command", { cmd: "echo again" }),
			() => failure(400, Flag.ContextOverflow),
		]);
		expect(result.kind).toBe("input_budget");
		expect(result.stats.checkpointRestarts).toBe(1);
	});
});
