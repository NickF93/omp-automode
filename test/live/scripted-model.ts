// Scripted OpenAI-compatible loopback model for live scenarios whose trigger a
// real cheap model does not reliably produce (it refuses injected actions, or
// never reaches the tool). OMP, the plugin, the host tools and, unless a case
// says otherwise, the reviewer model are all real; only the main agent's next
// turn is scripted. Evidence from these cases is labelled "scripted main agent"
// and is distinct from real-model acceptance.

export interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: { function: { name: string; parameters?: unknown } }[];
	stream?: boolean;
	reasoning_effort?: string;
	[key: string]: unknown;
}

export type Reply = { text: string } | { calls: { name: string; args: Record<string, unknown> }[] };

/** Text of a message's content, joining text parts. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(p => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
	}
	return "";
}

/** Messages after the last user message and the text of that user message. */
export function turn(req: ChatRequest): { user: string; after: ChatMessage[]; system: string } {
	const last = req.messages.findLastIndex(m => m.role === "user");
	return {
		user: last >= 0 ? textOf(req.messages[last]?.content) : "",
		after: last >= 0 ? req.messages.slice(last + 1) : req.messages,
		system: req.messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n"),
	};
}

/** Number of assistant turns already taken since the last user message. */
export function step(req: ChatRequest): number {
	return turn(req).after.filter(m => m.role === "assistant").length;
}

/** Tool results returned since the last user message, oldest first. */
export function toolResults(req: ChatRequest): string[] {
	return turn(req).after.filter(m => m.role === "tool").map(m => textOf(m.content));
}

let callSeq = 0;

function chunk(model: string, delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
	return `data: ${JSON.stringify({
		id: "scripted",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
		...(usage ? { usage } : {}),
	})}\n\n`;
}

export interface ScriptedModel {
	url: string;
	requests: ChatRequest[];
	stop(): void;
}

export function startScriptedModel(respond: (req: ChatRequest) => Reply): ScriptedModel {
	const requests: ChatRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(httpReq) {
			const url = new URL(httpReq.url);
			if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] });
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const req = (await httpReq.json()) as ChatRequest;
			requests.push(req);
			let reply: Reply;
			try {
				reply = respond(req);
			} catch (error) {
				reply = { text: `script error: ${(error as Error).message}` };
			}
			const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
			const body: string[] = [];
			if ("text" in reply) {
				body.push(chunk(req.model, { role: "assistant", content: reply.text }, null));
				body.push(chunk(req.model, {}, "stop", usage));
			} else {
				const calls = reply.calls.map((c, index) => ({
					index,
					id: `call_s${++callSeq}`,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				}));
				body.push(chunk(req.model, { role: "assistant", content: null, tool_calls: calls }, null));
				body.push(chunk(req.model, {}, "tool_calls", usage));
			}
			body.push("data: [DONE]\n\n");
			return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** models.yml for the scripted provider: two chat models with reasoning efforts. */
export function scriptedModelsYaml(url: string): string {
	const model = (id: string) =>
		`      - id: ${id}\n        name: ${id}\n        api: openai-completions\n        reasoning: true\n        input: [text, image]\n        contextWindow: 128000\n        maxTokens: 8192\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        compat:\n          supportsReasoningEffort: true\n          supportsDeveloperRole: false\n`;
	return `providers:\n  scripted:\n    baseUrl: ${url}\n    api: openai-completions\n    auth: none\n    models:\n${model("main")}${model("reviewer-b")}`;
}
