// A deterministic tool trigger through OMP, with a real or scripted reviewer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { USAGE_ENTRY, type summarizeUsage } from "../../src/usage";
import { Case, TASK, writeEvidence } from "./harness";
import { scriptedModelsYaml, startScriptedModel, step, turn } from "./scripted-model";

const reviewer = process.env.REVIEW_MODEL ?? "scripted/reviewer-b";
const command = "echo accounting-canary";
const withChild = reviewer === "scripted/reviewer-b";
const marker = "Account for a reviewer request.";
const childMarker = "ACCOUNTING-CHILD";
const bash = { name: "bash", args: { i: "Running accounting canary", command } };
const model = startScriptedModel(req => {
	if (req.model === "reviewer-b") return {
		text: JSON.stringify({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "The user requested a harmless echo." }),
	};
	const t = turn(req);
	if (t.user.includes(childMarker) && step(req) === 0) return { calls: [bash] };
	if (t.user.includes(marker) && step(req) === 0) return { calls: withChild ? [bash, {
		name: "task", args: { i: "Checking child usage", context: marker,
			tasks: [{ name: "Usage", task: childMarker, solutionSpace: "Run the harmless echo accounting-canary command." }] },
	}] : [bash] };
	return { text: "Done." };
});
const c = new Case({
	name: "usage",
	mainModel: "scripted/main",
	mainEffort: "low",
	models: scriptedModelsYaml(model.url),
	config: "advisor:\n  enabled: false\nmodelRoles:\n  default: scripted/main\n  task: scripted/main\n  smol: scripted/main\n",
	plugin: { model: reviewer, effort: "low" },
	pluginPath: process.env.AUTOMODE_LIVE_PLUGIN_PATH,
});
async function report(instance: Case) {
	const at = instance.notices().length;
	await instance.run("/auto-review usage --json", 15_000);
	const message = instance.notices().slice(at).find(text => text.startsWith('{"version":1,"native":'));
	assert(message, "usage command should emit structured counters");
	return JSON.parse(message) as ReturnType<typeof summarizeUsage>;
}
try {
	await c.start();
	await c.run(`${marker} I explicitly authorize running bash with the exact command ${command} in this fixture.`, 110_000);
	assert(c.toolEvents().some(event => event.name === "bash" && event.isError === false && event.result?.includes("accounting-canary")));
	const before = await report(c);
	assert(before.autoReview.measuredAttempts >= (withChild ? 2 : 1), JSON.stringify(before));
	assert.equal(before.autoReview.unmeasuredAttempts, 0);
	assert(before.autoReview.meters.totalTokens > 0);
	assert.equal(before.total.totalTokens, before.native.totalTokens + before.autoReview.meters.totalTokens);
	assert.equal(before.total.usd, before.native.usd + before.autoReview.meters.usd);
	const { sessionFile } = await c.client.getSessionStats();
	assert(sessionFile);
	const rows = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
	const entries = rows.filter(row => row.type === "custom" && row.customType === USAGE_ENTRY);
	assert.equal(entries.length, before.autoReview.measuredAttempts);
	if (withChild) assert.equal(before.autoReview.meters.totalTokens, entries.length * 2);
	const reopened = new Case({ ...c.opts, extraArgs: ["--resume", sessionFile] });
	await c.stop("usage-original");
	try {
		await reopened.start();
		const after = await report(reopened);
		assert.deepEqual(after, before);
		writeEvidence(path.join(TASK, "evidence", "usage.json"), JSON.stringify({
			reviewerRequested: reviewer, main: "scripted/main", resumed: true, toolExecuted: true, report: after,
		}, null, 2));
		console.log(JSON.stringify(after));
	} finally {
		await reopened.stop("usage-resumed");
	}
} finally {
	await c.stop("usage-original");
	model.stop();
}
