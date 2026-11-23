import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { summarizeUsage, USAGE_ENTRY, usageSample, usageTarget } from "../src/usage";

type Manager = ExtensionContext["sessionManager"];

test("retains usage across branches and resume without charging duplicate or inherited records", () => {
	let sessionId = "a";
	const entries: ReturnType<Manager["getEntries"]> = [];
	const session = {
		getSessionId: () => sessionId,
		getEntries: () => entries.slice(),
		getUsageStatistics: () => ({
			input: 10, output: 20, totalTokens: 30, cacheRead: 0, cacheWrite: 0, cost: 0.5,
			orchestrationInput: 0, orchestrationOutput: 0, orchestrationCacheRead: 0, premiumRequests: 0, subagentCost: 0,
		}),
	};
	const write = usageTarget(session, (customType, data) => {
		entries.push({ type: "custom", customType, data, id: String(entries.length), parentId: null, timestamp: "" });
	}, () => { throw Error("unexpected write failure"); });
	const unknown = usageSample({ provider: "test", id: "reviewer" }, undefined);
	const measured = { ...unknown, outcome: "stop" as const, id: "measured", meters: {
		input: 2, output: 3, cacheRead: 4, cacheWrite: 1, totalTokens: 10, usd: 0.125, committedCredits: 0.25,
	} };
	write(unknown);
	write(measured);
	write(measured);
	entries.push({
		type: "custom", customType: "omp-automode", id: "legacy", timestamp: "", parentId: null,
		data: { kind: "result", action: { session: "a" }, samplingRequests: 5 },
	});
	const report = summarizeUsage(session);
	expect(report.autoReview).toMatchObject({ measuredAttempts: 1, unmeasuredAttempts: 0, unobservedCompletions: 1, legacyAttempts: 5 });
	expect(report.autoReview.byModel[0]?.meters.committedCredits).toBe(0.25);
	expect(report.total).toMatchObject({ input: 12, output: 23, cacheRead: 4, cacheWrite: 1, totalTokens: 40, usd: 0.625 });
	sessionId = "fork";
	write(unknown);
	expect(entries.filter(e => e.type === "custom" && e.customType === USAGE_ENTRY)).toHaveLength(3);
	const fork = summarizeUsage(session);
	expect(fork.autoReview).toMatchObject({ measuredAttempts: 0, unmeasuredAttempts: 0, legacyAttempts: 0 });
	expect(fork.native.usd).toBe(0.5);
	expect(fork.inheritedReviewerHistory).toBe(true);
	expect(fork.total).toBeNull();
	sessionId = "a";
	expect(summarizeUsage(session)).toEqual(report);
});
