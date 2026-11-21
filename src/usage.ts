import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ENTRY_TYPE, isRecord } from "./state";

export const USAGE_ENTRY = "omp-automode.usage";
const metrics = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "usd"] as const;
const optionalMetrics = ["reasoningTokens", "premiumRequests", "credits", "committedCredits", "acus"] as const;

type Meters = Record<(typeof metrics)[number], number> &
	Partial<Record<(typeof optionalMetrics)[number], number>>;
type Sample = {
	id: string;
	provider: string;
	model: string;
	outcome: AssistantMessage["stopReason"] | "unobserved";
	meters: Meters | null;
};

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readMeters(value: unknown): Meters | null {
	if (!isRecord(value) || !metrics.every(key => nonnegative(value[key]))) return null;
	if (!optionalMetrics.every(key => value[key] === undefined || nonnegative(value[key]))) return null;
	return value as Meters;
}

function measured(usage: Usage | undefined): Meters | null {
	if (!usage) return null;
	const meters = readMeters({
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		usd: usage.cost?.total,
		reasoningTokens: usage.reasoningTokens,
		premiumRequests: usage.premiumRequests,
		credits: usage.credits?.cost,
		committedCredits: usage.credits?.committedCost,
		acus: usage.credits?.acuCost,
	});
	return meters && Object.values(meters).some(value => value > 0) ? meters : null;
}

export function usageSample(
	model: { provider: string; id: string },
	response: AssistantMessage | undefined,
): Sample {
	return {
		id: crypto.randomUUID(),
		provider: response?.provider ?? model.provider,
		model: response?.upstreamModel ?? response?.model ?? model.id,
		outcome: response?.stopReason ?? "unobserved",
		meters: measured(response?.usage),
	};
}

export type UsageTarget = (sample: Sample) => void;

export function usageTarget(
	session: Pick<ExtensionContext["sessionManager"], "getSessionId">,
	append: (type: string, data: unknown) => void,
	onError: () => void,
): UsageTarget {
	const sessionId = session.getSessionId();
	return sample => {
		if (session.getSessionId() !== sessionId) return;
		try {
			append(USAGE_ENTRY, { v: 1, sessionId, ...sample });
		} catch {
			onError();
		}
	};
}

function emptyMeters(): Meters {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, usd: 0 };
}

function bucket() {
	return { measuredAttempts: 0, unmeasuredAttempts: 0, meters: emptyMeters() };
}

function addSample(target: ReturnType<typeof bucket>, meters: Meters | null): void {
	if (!meters) {
		target.unmeasuredAttempts++;
		return;
	}
	target.measuredAttempts++;
	for (const key of metrics) target.meters[key] += meters[key];
	for (const key of optionalMetrics) {
		const value = meters[key];
		if (value !== undefined) target.meters[key] = (target.meters[key] ?? 0) + value;
	}
}

export function summarizeUsage(
	session: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getUsageStatistics">,
) {
	const sessionId = session.getSessionId();
	const stats = session.getUsageStatistics();
	const native: Meters = {
		input: stats.input, output: stats.output, cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite, totalTokens: stats.totalTokens, usd: stats.cost,
		premiumRequests: stats.premiumRequests,
	};
	const autoReview = bucket();
	const byModel = new Map<string, { provider: string; model: string } & ReturnType<typeof bucket>>();
	const seen = new Set<string>();
	let legacyAttempts = 0;
	for (const entry of session.getEntries()) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		const data = entry.data;
		if (entry.customType === ENTRY_TYPE && data.kind === "result" && data.usageAccounting !== true &&
			isRecord(data.action) && data.action.session === sessionId && nonnegative(data.samplingRequests)) {
			legacyAttempts += data.samplingRequests;
		}
		if (entry.customType !== USAGE_ENTRY || data.v !== 1 || data.sessionId !== sessionId ||
			typeof data.id !== "string" || typeof data.provider !== "string" || typeof data.model !== "string" ||
			seen.has(data.id)) continue;
		seen.add(data.id);
		const meters = readMeters(data.meters);
		addSample(autoReview, meters);
		const key = JSON.stringify([data.provider, data.model]);
		let group = byModel.get(key);
		if (!group) {
			group = { provider: data.provider, model: data.model, ...bucket() };
			byModel.set(key, group);
		}
		addSample(group, meters);
	}
	const total = emptyMeters();
	for (const key of metrics) total[key] = native[key] + autoReview.meters[key];
	total.premiumRequests = (native.premiumRequests ?? 0) + (autoReview.meters.premiumRequests ?? 0);
	return { version: 1, native, autoReview: { ...autoReview, legacyAttempts, byModel: [...byModel.values()] }, total };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 8 });

export function formatUsage(report: ReturnType<typeof summarizeUsage>): string {
	const display = (m: Meters) => `${m.totalTokens.toLocaleString("en-US")} tokens · ${usd.format(m.usd)} estimated USD`;
	const { autoReview } = report;
	const m = autoReview.meters;
	const lines = [
		`Session total (observed) · ${display(report.total)}`,
		`OMP native · ${display(report.native)}`,
		`Auto-review · ${display(m)} · ${autoReview.measuredAttempts} measured, ${autoReview.unmeasuredAttempts} unmeasured, ${autoReview.legacyAttempts} historical attempts without usage`,
		`  Input ${m.input} · output ${m.output} · cache read ${m.cacheRead} · cache write ${m.cacheWrite}`,
	];
	for (const group of autoReview.byModel) {
		lines.push(`  ${group.provider}/${group.model} · ${display(group.meters)} · ${group.measuredAttempts} measured, ${group.unmeasuredAttempts} unmeasured`);
	}
	for (const [key, label] of [
		["credits", "Auto-review credits"], ["committedCredits", "Auto-review committed credits"],
		["acus", "Auto-review ACUs"], ["premiumRequests", "Premium requests (combined)"],
	] as const) {
		const value = key === "premiumRequests" ? report.total[key] : m[key];
		if (value) lines.push(`${label} · ${value}`);
	}
	return lines.join("\n");
}
