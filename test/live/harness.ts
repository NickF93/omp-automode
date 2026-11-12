// Live validation harness: isolated OMP RPC processes driven by OMP's RpcClient.
// Each case owns HOME/agent/cache/session/work dirs under the task directory.
// The child reaches credentials only through the temporary loopback broker,
// with the bearer read by a native `!cat` reference; no secret is passed in
// argv or environment, and evidence is scanned in memory before it is written.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for live scenarios (see test/live/README.md)`);
	return value;
}

/** Writable task directory holding cases and evidence. */
export const TASK = path.resolve(required("AUTOMODE_LIVE_DIR"));
export const TARGET = path.resolve(import.meta.dir, "../..");
const TOKEN_FILE = path.resolve(required("AUTOMODE_LIVE_BROKER_TOKEN_FILE"));
const BROKER_URL = required("AUTOMODE_LIVE_BROKER_URL");
const SECRET = readFileSync(TOKEN_FILE, "utf8").trim();

export interface Frame {
	t: number;
	frame: Record<string, unknown>;
}

export interface CaseOptions {
	name: string;
	mainModel: string;
	mainEffort?: string;
	plugin?: Record<string, unknown>;
	extraArgs?: string[];
	loadPlugin?: boolean;
	files?: Record<string, string>;
	config?: string;
	/** Agent-level models.yml, for custom loopback providers. */
	models?: string;
	/** Answer extension UI requests; undefined cancels, null leaves the request unanswered. */
	ui?: (req: Record<string, unknown>) => Record<string, unknown> | undefined | null;
}

export function assertNoSecret(label: string, text: string): void {
	if (SECRET.length > 8 && text.includes(SECRET)) throw new Error(`secret detected in ${label}; evidence not written`);
}

export function writeEvidence(file: string, text: string): void {
	assertNoSecret(file, text);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, text, { mode: 0o600 });
}

export class Case {
	readonly dir: string;
	readonly work: string;
	readonly frames: Frame[] = [];
	client!: RpcClient;
	#stderr = "";
	#stdin?: { write(data: string): unknown };
	#started = Date.now();

	constructor(readonly opts: CaseOptions) {
		this.dir = path.join(TASK, "work", "cases", opts.name);
		this.work = path.join(this.dir, "work");
	}

	async start(): Promise<void> {
		for (const sub of ["home", "agent", "tmp", "cache", "state", "data", "work", "sessions"]) {
			mkdirSync(path.join(this.dir, sub), { recursive: true, mode: 0o700 });
		}
		chmodSync(this.dir, 0o700);
		writeFileSync(
			path.join(this.dir, "agent", "config.yml"),
			`auth:\n  broker:\n    url: ${BROKER_URL}\n    token: "!cat '${TOKEN_FILE}'"\n${this.opts.config ?? ""}`,
			{ mode: 0o600 },
		);
		if (this.opts.models) writeFileSync(path.join(this.dir, "agent", "models.yml"), this.opts.models, { mode: 0o600 });
		for (const [rel, content] of Object.entries(this.opts.files ?? {})) {
			const file = path.join(this.work, rel);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, content);
		}
		if (this.opts.plugin) {
			// Global plugin settings in the isolated HOME, outside the agent's working tree.
			const plugins = path.join(this.dir, "home", ".omp", "plugins");
			mkdirSync(plugins, { recursive: true });
			writeFileSync(
				path.join(plugins, "omp-plugins.lock.json"),
				JSON.stringify({ plugins: {}, settings: { "omp-automode": this.opts.plugin } }, null, 2),
			);
		}
		// A repository root at the case's working directory bounds native project discovery
		// (context files, skills, rules) so the surrounding checkout cannot leak into the case.
		if (!existsSync(path.join(this.work, ".git"))) {
			Bun.spawnSync(["git", "init", "-q", this.work]);
		}
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: path.join(this.dir, "home"),
			OMP_PROFILE: "default",
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: path.join(this.dir, "agent"),
			TMPDIR: path.join(this.dir, "tmp"),
			XDG_CACHE_HOME: path.join(this.dir, "cache"),
			XDG_STATE_HOME: path.join(this.dir, "state"),
			XDG_DATA_HOME: path.join(this.dir, "data"),
			TERM: "dumb",
			LANG: "C.UTF-8",
		};
		const args = [
			"--cwd",
			this.work,
			"--no-extensions",
			...(this.opts.loadPlugin === false ? [] : ["-e", TARGET]),
			"--approval-mode",
			"yolo",
			"--model",
			this.opts.mainModel,
			...(this.opts.mainEffort ? ["--thinking", this.opts.mainEffort] : []),
			"--no-title",
			...(this.opts.extraArgs ?? []),
		];
		const spawn = (agentArgs: string[]): RpcAgentProcess => {
			const proc = Bun.spawn(["omp", ...agentArgs, ...args], {
				cwd: this.work,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			void (async () => {
				for await (const chunk of proc.stderr) this.#stderr += new TextDecoder().decode(chunk);
			})();
			const [forClient, forUs] = proc.stdout.tee();
			void this.#observe(forUs);
			this.#stdin = { write: (data: string) => proc.stdin.write(data) };
			return {
				stdin: { write: data => proc.stdin.write(data) },
				stdout: forClient,
				peekStderr: () => this.#stderr,
				kill: signal => proc.kill(typeof signal === "string" || typeof signal === "number" ? signal : undefined),
				exited: proc.exited,
			};
		};
		this.client = new RpcClient({ spawn, sessionDir: path.join(this.dir, "sessions") });
		await this.client.start();
	}

	async #observe(stream: ReadableStream<Uint8Array>): Promise<void> {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				this.frames.push({ t: Date.now() - this.#started, frame });
				if (frame.type === "extension_ui_request") this.#answer(frame);
			}
		}
	}

	#answer(req: Record<string, unknown>): void {
		const method = req.method;
		if (!["select", "confirm", "input", "editor", "ask"].includes(String(method))) return;
		const reply = this.opts.ui?.(req);
		if (reply === null) return;
		const frame = reply ? { type: "extension_ui_response", id: req.id, ...reply } : { type: "extension_ui_response", id: req.id, cancelled: true };
		this.#stdin?.write(`${JSON.stringify(frame)}\n`);
	}

	/** Send a prompt, wait for its own prompt_result, then for the session to settle. */
	async run(message: string, timeoutMs = 600_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const results = new Map<string, unknown>();
		let wake = Promise.withResolvers<void>();
		const offResult = this.client.onPromptResult(frame => {
			results.set(String(frame.id), frame);
			wake.resolve();
		});
		const offSettled = this.client.onSessionSettled(() => wake.resolve());
		const pause = async () => {
			await Promise.race([wake.promise, Bun.sleep(2_000)]);
			wake = Promise.withResolvers<void>();
			if (Date.now() > deadline) throw new Error(`case ${this.opts.name} timed out`);
		};
		try {
			const id = await this.client.prompt(message);
			while (!results.has(id)) await pause();
			while (!(await this.client.getState()).isSettled) await pause();
		} finally {
			offResult();
			offSettled();
		}
	}

	toolEvents(): { name: string; args: unknown; isError?: boolean; result?: string; id: string }[] {
		const calls = new Map<string, { name: string; args: unknown; isError?: boolean; result?: string; id: string }>();
		for (const { frame } of this.frames) {
			if (frame.type === "tool_execution_start") {
				calls.set(String(frame.toolCallId), { id: String(frame.toolCallId), name: String(frame.toolName), args: frame.args });
			} else if (frame.type === "tool_execution_end") {
				const call = calls.get(String(frame.toolCallId)) ?? { id: String(frame.toolCallId), name: String(frame.toolName), args: undefined };
				call.isError = frame.isError === true;
				const result = frame.result as { content?: { type: string; text?: string }[] } | undefined;
				call.result = (result?.content ?? []).map(p => p.text ?? "").join("").slice(0, 2000);
				calls.set(call.id, call);
			}
		}
		return [...calls.values()];
	}

	notices(): string[] {
		return this.frames
			.filter(({ frame }) => frame.type === "extension_ui_request" && frame.method === "notify")
			.map(({ frame }) => String(frame.message));
	}

	async stop(evidenceName = this.opts.name): Promise<void> {
		try {
			await this.client.stop();
		} catch {
			// already exited
		}
		const out = path.join(TASK, "evidence", "live", evidenceName);
		writeEvidence(path.join(out, "frames.jsonl"), this.frames.map(f => JSON.stringify(f)).join("\n"));
		writeEvidence(path.join(out, "stderr.txt"), this.#stderr);
	}
}
