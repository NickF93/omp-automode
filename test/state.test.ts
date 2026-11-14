import { describe, expect, test } from "bun:test";
import {
	type ActionKey,
	CircuitBreaker,
	ENTRY_TYPE,
	type PersistedEntry,
	type ResultEntry,
	SessionState,
	type Verdict,
} from "../src/state";

const deny: Verdict = { outcome: "deny", risk_level: "high", user_authorization: "low", rationale: "deletes shared data" };
const action = (n: number): ActionKey => ({ tool: "bash", input: { command: `rm -rf /data/${n}` }, cwd: "/w", session: "s1" });

function result(id: string, a: ActionKey, verdict?: Verdict): ResultEntry {
	return {
		v: 1,
		kind: "result",
		id,
		runId: "1",
		toolCallId: `call-${id}`,
		action: a,
		model: "p/m",
		effort: "low",
		result: verdict ? "verdict" : "timeout",
		...(verdict ? { verdict } : {}),
		attempts: 1,
		checkpointRestarts: 0,
		samplingRequests: 1,
		elapsedMs: 10,
	};
}

function recorder() {
	const entries: { type: string; customType: string; data: PersistedEntry }[] = [];
	const state = new SessionState((customType, data) => entries.push({ type: "custom", customType, data }));
	return { state, entries };
}

describe("circuit breaker", () => {
	const run = (sequence: boolean[]) => {
		const breaker = new CircuitBreaker();
		return sequence.map(denied => breaker.record(denied));
	};

	test("three consecutive denials trip once", () => {
		const trips = run([true, true, true, true]);
		expect(trips.slice(0, 2)).toEqual([undefined, undefined]);
		expect(trips[2]).toEqual({ consecutive: 3, inWindow: 3, windowSize: 3 });
		expect(trips[3]).toBeUndefined();
	});

	test("any non-denial result resets the consecutive count: deny, timeout, deny, deny does not trip", () => {
		expect(run([true, false, true, true]).every(t => t === undefined)).toBe(true);
	});

	test("ten denials among the last fifty trip even without three in a row", () => {
		const sequence: boolean[] = [];
		for (let i = 0; i < 10; i++) sequence.push(true, false);
		const trips = run(sequence);
		expect(trips.findIndex(Boolean)).toBe(18);
		expect(trips[18]).toEqual({ consecutive: 1, inWindow: 10, windowSize: 19 });
	});

	test("denials older than the fifty-result window no longer count", () => {
		const sequence: boolean[] = [];
		for (let i = 0; i < 9; i++) sequence.push(true, false);
		for (let i = 0; i < 40; i++) sequence.push(false);
		sequence.push(true);
		expect(run(sequence).every(t => t === undefined)).toBe(true);
	});

	test("reset starts a fresh run", () => {
		const breaker = new CircuitBreaker();
		breaker.record(true);
		breaker.record(true);
		breaker.reset();
		expect(breaker.record(true)).toBeUndefined();
	});
});

describe("session state replay", () => {
	test("replay restores the latest overrides, the on/off switch and recent denials of the branch, never grants", () => {
		const { state, entries } = recorder();
		const overrides = {
			model: "p/a",
			effort: "high",
			timeoutMs: 120_000,
			rules: [{ prefix: ["git", "status"], decision: "allow" as const }],
			extraPolicy: "",
		};
		state.setOverrides(overrides);
		state.setEnabled(false);
		state.recordResult(result("d1", action(1), deny));
		state.recordResult(result("t1", action(2)));
		state.grant(state.recentDenials()[0]!, "leaf");

		const resumed = new SessionState(() => {});
		resumed.replay(entries);
		expect(resumed.overrides).toEqual(overrides);
		expect(resumed.enabled).toBe(false);
		expect(resumed.recentDenials().map(d => d.id)).toEqual(["d1"]);
		expect(resumed.claim(action(1), "call-x")).toBeUndefined();
	});

	test("turning review back on replays as on, and a branch without a switch entry is on", () => {
		const { state, entries } = recorder();
		state.setEnabled(false);
		state.setEnabled(true);
		const resumed = new SessionState(() => {});
		resumed.replay(entries);
		expect(resumed.enabled).toBe(true);
		resumed.setEnabled(false);
		resumed.replay([]);
		expect(resumed.enabled).toBe(true);
	});

	test("a cleared override replays as inherit", () => {
		const { state, entries } = recorder();
		state.setOverrides({ model: "p/a", effort: null, timeoutMs: null, rules: null, extraPolicy: null });
		state.setOverrides(undefined);
		const resumed = new SessionState(() => {});
		resumed.replay(entries);
		expect(resumed.overrides).toBeUndefined();
	});

	test("a model and effort selection written by 0.1.0 still restores", () => {
		const resumed = new SessionState(() => {});
		resumed.replay([{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, kind: "selection", model: "p/a", effort: "low" } }]);
		expect(resumed.overrides).toEqual({ model: "p/a", effort: "low", timeoutMs: null, rules: null, extraPolicy: null });
	});

	test("legacy denials remain approvable; provenance alone never creates a grant", () => {
		const legacy = result("legacy", action(1), deny);
		const current = { ...result("current", action(2), deny), provenance: {
			packageVersion: "0.2.2", verdictContract: "complete-v1" as const, instructionsSha256: "a".repeat(64),
		} };
		const resumed = new SessionState(() => {});
		resumed.replay([legacy, current].map(data => ({ type: "custom", customType: ENTRY_TYPE, data })));
		expect(resumed.recentDenials().map(d => d.id)).toEqual(["current", "legacy"]);
		expect(resumed.claim(action(1), "unapproved-old")).toBeUndefined();
		expect(resumed.claim(action(2), "unapproved-new")).toBeUndefined();
		resumed.grant(resumed.recentDenials().find(d => d.id === "legacy")!, "leaf");
		expect(resumed.claim(action(1), "approved-old")?.verdict).toEqual(deny);
		expect(resumed.claim(action(1), "second-use")).toBeUndefined();
	});

	test("an empty model or effort is not a selection: the entry is ignored", () => {
		const resumed = new SessionState(() => {});
		const selection = (data: Record<string, unknown>) => ({
			type: "custom",
			customType: ENTRY_TYPE,
			data: { v: 1, kind: "selection", timeoutMs: 120_000, ...data },
		});
		resumed.replay([selection({ model: "", effort: null }), selection({ model: null, effort: "" })]);
		expect(resumed.overrides).toBeUndefined();
		resumed.replay([selection({ model: null, effort: null, extraPolicy: "" })]);
		expect(resumed.overrides?.extraPolicy).toBe("");
	});

	test("only the latest ten denial events are offered, newest first, without collapsing repeats", () => {
		const { state } = recorder();
		for (let i = 0; i < 12; i++) state.recordResult(result(`d${i}`, action(i % 2), deny));
		const ids = state.recentDenials().map(d => d.id);
		expect(ids).toHaveLength(10);
		expect(ids[0]).toBe("d11");
		expect(ids.at(-1)).toBe("d2");
	});

	test("malformed persisted entries are ignored", () => {
		const resumed = new SessionState(() => {});
		const selection = (extra: Record<string, unknown>) => ({
			type: "custom",
			customType: ENTRY_TYPE,
			data: { v: 1, kind: "selection", model: "p/x", effort: null, ...extra },
		});
		resumed.replay([
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, kind: "result", id: "x", verdict: { outcome: "deny" } } },
			{ type: "custom", customType: ENTRY_TYPE, data: "garbage" },
			{ type: "custom", customType: "other", data: { v: 1, kind: "selection", model: "p/x", effort: null } },
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, kind: "enabled", enabled: "no" } },
			selection({ rules: [{ prefix: [], decision: "allow" }] }),
			selection({ rules: '[{"prefix":["ls"],"decision":"allow"}]' }),
			selection({ timeoutMs: -1 }),
			selection({ timeoutMs: "90000" }),
		]);
		expect(resumed.recentDenials()).toEqual([]);
		expect(resumed.overrides).toBeUndefined();
		expect(resumed.enabled).toBe(true);
	});
});

describe("one-use grants", () => {
	const denial = { id: "d1", action: action(1), verdict: deny };

	test("a grant is consumed exactly once and only for the identical action", () => {
		const { state, entries } = recorder();
		state.recordResult(result("d1", action(1), deny));
		state.grant(state.recentDenials()[0]!, "leaf");

		expect(state.claim(action(2), "c1")).toBeUndefined();
		const reordered: ActionKey = { session: "s1", cwd: "/w", input: { command: "rm -rf /data/1" }, tool: "bash" };
		expect(state.claim(reordered, "c2")?.id).toBe("d1");
		expect(state.claim(action(1), "c3")).toBeUndefined();
		const kinds = entries.map(e => e.data.kind);
		expect(kinds).toEqual(["result", "approval", "consumed"]);
	});

	test("the same action in another session or cwd does not match", () => {
		const { state } = recorder();
		state.grant(denial, null);
		expect(state.claim({ ...action(1), session: "s2" }, "c")).toBeUndefined();
		expect(state.claim({ ...action(1), cwd: "/other" }, "c")).toBeUndefined();
	});

	test("a failing audit append blocks the dependent claim and does not leave a reusable grant", () => {
		let fail = false;
		const state = new SessionState(() => {
			if (fail) throw new Error("disk full");
		});
		state.grant(denial, null);
		fail = true;
		expect(() => state.claim(action(1), "c")).toThrow("disk full");
		fail = false;
		expect(state.claim(action(1), "c")).toBeUndefined();
	});

	test("live expiry drops pending grants", () => {
		const { state } = recorder();
		state.grant(denial, null);
		state.expireLive();
		expect(state.claim(action(1), "c")).toBeUndefined();
	});

	test("a manual run records its approval and its use together, leaving no grant", () => {
		const { state, entries } = recorder();
		state.approveManualRun(action(1), "leaf", "c1");
		const [approval, consumed] = entries.map(e => e.data);
		expect(approval).toMatchObject({ v: 1, kind: "approval", approvalKind: "input_budget", action: action(1), branchLeaf: "leaf", provenance: "input_budget_confirm" });
		expect(consumed).toEqual({ v: 1, kind: "consumed", approvalId: approval?.kind === "approval" ? approval.id : "", toolCallId: "c1" });
		expect(state.claim(action(1), "c2")).toBeUndefined();
	});
});

describe("device envelope deduplication", () => {
	test("only the matching inner call of a gated envelope is passed through, once", () => {
		const { state } = recorder();
		state.markDeviceGated("call-1", "eval");
		expect(state.takeDeviceGated("call-2", "eval")).toBe(false);
		expect(state.takeDeviceGated("call-1", "bash")).toBe(false);
		expect(state.takeDeviceGated("call-1", "eval")).toBe(true);
		expect(state.takeDeviceGated("call-1", "eval")).toBe(false);
	});
});
