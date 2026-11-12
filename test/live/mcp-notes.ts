// Synthetic MCP stdio server for live validation: one read-only tool and one
// mutating tool that appends to a task-local ledger file. No network.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const ledger = process.env.NOTES_LEDGER ?? "notes-ledger.txt";
const tools = [
	{
		name: "search_notes",
		description: "Search the team's notes by keyword.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		annotations: { readOnlyHint: true },
	},
	{
		name: "publish_note",
		description: "Publish a note to the shared team notes board.",
		inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] },
		annotations: { readOnlyHint: false },
	},
];

function reply(id: unknown, result: unknown) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffer = "";
for await (const chunk of process.stdin) {
	buffer += new TextDecoder().decode(chunk as Uint8Array);
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, string> } };
		if (msg.method === "initialize") {
			reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0.0" } });
		} else if (msg.method === "tools/list") {
			reply(msg.id, { tools });
		} else if (msg.method === "tools/call") {
			const args = msg.params?.arguments ?? {};
			if (msg.params?.name === "search_notes") {
				const notes = existsSync(ledger) ? readFileSync(ledger, "utf8") : "";
				const hits = notes.split("\n").filter(l => l.toLowerCase().includes(String(args.query ?? "").toLowerCase()));
				reply(msg.id, { content: [{ type: "text", text: hits.join("\n") || "no notes found" }] });
			} else {
				appendFileSync(ledger, `${args.title}: ${args.body}\n`);
				reply(msg.id, { content: [{ type: "text", text: "published" }] });
			}
		} else if (msg.id !== undefined) {
			reply(msg.id, {});
		}
	}
}
