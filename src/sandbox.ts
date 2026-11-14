/**
 * Read-only, network-less investigation for the reviewer.
 *
 * Every command runs under one fixed bubblewrap profile: the whole filesystem
 * read-only, private /tmp and /run, all namespaces unshared (no network), a
 * cleared environment, and death with the parent. There is no unsandboxed
 * fallback. Only the reviewer's investigations run here; the main agent is
 * not sandboxed.
 */
import { homedir } from "node:os";
import type { ImageContent, Tool } from "@oh-my-pi/pi-ai";
import { BYTES_PER_TOKEN, TOOL_ENTRY_MAX_TOKENS } from "./policy";
import { truncateMiddle } from "./context";

/** Exact bubblewrap profile; argv is passed directly, never through a host shell. */
function bwrapArgv(cwd: string, command: string): string[] {
	return [
		"bwrap",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--clearenv",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"HOME",
		homedir(),
		"--chdir",
		cwd,
		"--",
		"/bin/bash",
		"-c",
		command,
	];
}

export class SandboxUnavailableError extends Error {
	override readonly name = "SandboxUnavailableError";
}

const DEFAULT_YIELD_MS = 10_000;
const MAX_YIELD_MS = 30_000;
/** Bytes retained per process before older output is dropped. */
const MAX_BUFFER_BYTES = 1 << 20;
const MAX_IMAGE_BYTES = 10 << 20;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

interface Investigation {
	id: number;
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	output: Uint8Array[];
	bufferedBytes: number;
	droppedBytes: number;
	exitCode: number | null;
	exited: Promise<void>;
}

/** Reviewer tool definitions with explicit input schemas. */
export const INVESTIGATION_TOOLS: Tool[] = [
	{
		name: "exec_command",
		description:
			"Run a read-only bash command in the sandbox. Returns its output and exit code, or a session_id if it is still running after yield_time_ms.",
		parameters: {
			type: "object",
			properties: {
				cmd: { type: "string", description: "Command line run with bash -c." },
				workdir: { type: "string", description: "Absolute working directory; defaults to the action's cwd." },
				yield_time_ms: { type: "number", description: "How long to wait for output before returning (max 30000)." },
				max_output_tokens: { type: "number", description: "Approximate output limit (max 1000)." },
			},
			required: ["cmd"],
			additionalProperties: false,
		},
	},
	{
		name: "write_stdin",
		description:
			"Write characters to a running command's stdin (empty chars only polls), then return new output and the exit code once it has exited.",
		parameters: {
			type: "object",
			properties: {
				session_id: { type: "number" },
				chars: { type: "string" },
				close_stdin: { type: "boolean" },
				yield_time_ms: { type: "number" },
				max_output_tokens: { type: "number" },
			},
			required: ["session_id"],
			additionalProperties: false,
		},
	},
	{
		name: "wait",
		description: "Wait until all listed running commands exit or timeout_ms passes; returns each one's new output.",
		parameters: {
			type: "object",
			properties: {
				session_ids: { type: "array", items: { type: "number" } },
				timeout_ms: { type: "number" },
			},
			required: ["session_ids"],
			additionalProperties: false,
		},
	},
	{
		name: "view_image",
		description: "Show a local image file (png, jpeg, gif, webp).",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
];

interface ToolOutcome {
	text: string;
	image?: ImageContent;
	isError: boolean;
}

function num(value: unknown, fallback: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
}

/**
 * Owns all investigation processes of one review attempt. `dispose()` kills
 * and reaps every descendant; later results are discarded.
 */
export class Sandbox {
	#next = 1;
	#processes = new Map<number, Investigation>();
	#disposed = false;
	readonly #cwd: string;
	readonly #imageInput: boolean;

	constructor(cwd: string, imageInput: boolean) {
		this.#cwd = cwd;
		this.#imageInput = imageInput;
	}

	/** Verify bubblewrap can start the exact profile (from `/`, so a missing cwd is a tool error, not this); never falls back. */
	static async probe(): Promise<void> {
		let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
		try {
			proc = Bun.spawn(bwrapArgv("/", "true"), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		} catch (error) {
			throw new SandboxUnavailableError(`bubblewrap could not start: ${(error as Error).message}`);
		}
		const code = await proc.exited;
		if (code !== 0) {
			const stderr = (await new Response(proc.stderr).text()).trim().slice(0, 300);
			throw new SandboxUnavailableError(`bubblewrap sandbox is unavailable (exit ${code}): ${stderr}`);
		}
	}

	async run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
		if (this.#disposed || signal.aborted) return { text: "Review ended.", isError: true };
		switch (name) {
			case "exec_command":
				return this.#exec(args, signal);
			case "write_stdin":
				return this.#writeStdin(args, signal);
			case "wait":
				return this.#wait(args, signal);
			case "view_image":
				return this.#viewImage(args, signal);
			default:
				return { text: `Unknown tool ${name}.`, isError: true };
		}
	}

	#start(cmd: string, workdir: string): Investigation {
		const proc = Bun.spawn(bwrapArgv(workdir, cmd), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const inv: Investigation = {
			id: this.#next++,
			proc,
			output: [],
			bufferedBytes: 0,
			droppedBytes: 0,
			exitCode: null,
			exited: Promise.resolve(),
		};
		const pump = async (stream: ReadableStream<Uint8Array>) => {
			for await (const chunk of stream) {
				inv.output.push(chunk);
				inv.bufferedBytes += chunk.byteLength;
				while (inv.bufferedBytes > MAX_BUFFER_BYTES && inv.output.length > 1) {
					const dropped = inv.output.shift() as Uint8Array;
					inv.bufferedBytes -= dropped.byteLength;
					inv.droppedBytes += dropped.byteLength;
				}
			}
		};
		inv.exited = Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]).then(([, , code]) => {
			inv.exitCode = code;
		});
		this.#processes.set(inv.id, inv);
		return inv;
	}

	/** Wait up to `ms` for exit, then drain and format new output. */
	async #collect(inv: Investigation, ms: number, maxTokens: number, signal: AbortSignal): Promise<ToolOutcome> {
		await Promise.race([inv.exited, Bun.sleep(ms), abortPromise(signal)]);
		const bytes = Buffer.concat(inv.output);
		inv.output = [];
		inv.bufferedBytes = 0;
		let text = truncateMiddle(new TextDecoder().decode(bytes), maxTokens * BYTES_PER_TOKEN);
		if (inv.droppedBytes > 0) {
			text = `[${inv.droppedBytes} earlier output bytes dropped]\n${text}`;
			inv.droppedBytes = 0;
		}
		if (inv.exitCode !== null) {
			this.#processes.delete(inv.id);
			return { text: `exit_code: ${inv.exitCode}\noutput:\n${text}`, isError: false };
		}
		return { text: `session_id: ${inv.id} (still running)\noutput:\n${text}`, isError: false };
	}

	async #exec(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
		const cmd = args.cmd;
		if (typeof cmd !== "string" || cmd.trim().length === 0) return { text: "cmd is required.", isError: true };
		const workdir = typeof args.workdir === "string" && args.workdir.startsWith("/") ? args.workdir : this.#cwd;
		const inv = this.#start(cmd, workdir);
		return this.#collect(
			inv,
			num(args.yield_time_ms, DEFAULT_YIELD_MS, MAX_YIELD_MS),
			num(args.max_output_tokens, TOOL_ENTRY_MAX_TOKENS, TOOL_ENTRY_MAX_TOKENS),
			signal,
		);
	}

	async #writeStdin(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
		const inv = typeof args.session_id === "number" ? this.#processes.get(args.session_id) : undefined;
		if (!inv) return { text: "Unknown or finished session_id.", isError: true };
		// stdin can block on a process that does not read; abort must still end the review.
		const io = (async () => {
			if (typeof args.chars === "string" && args.chars.length > 0) {
				inv.proc.stdin.write(args.chars);
				await inv.proc.stdin.flush();
			}
			if (args.close_stdin === true) await inv.proc.stdin.end();
		})();
		// A write cut short by the kill below rejects later; nothing else waits for it.
		void io.catch(() => {});
		await Promise.race([io, abortPromise(signal)]);
		if (signal.aborted) {
			inv.proc.kill("SIGKILL");
			return { text: "Review ended.", isError: true };
		}
		return this.#collect(
			inv,
			num(args.yield_time_ms, 1_000, MAX_YIELD_MS),
			num(args.max_output_tokens, TOOL_ENTRY_MAX_TOKENS, TOOL_ENTRY_MAX_TOKENS),
			signal,
		);
	}

	async #wait(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
		const ids = Array.isArray(args.session_ids) ? args.session_ids : [];
		const found = ids.flatMap(id => {
			const inv = typeof id === "number" ? this.#processes.get(id) : undefined;
			return inv ? [inv] : [];
		});
		if (found.length === 0) return { text: "No running session_ids.", isError: true };
		const timeout = num(args.timeout_ms, DEFAULT_YIELD_MS, MAX_YIELD_MS);
		await Promise.race([Promise.all(found.map(inv => inv.exited)), Bun.sleep(timeout), abortPromise(signal)]);
		const perProcess = Math.max(100, Math.floor(TOOL_ENTRY_MAX_TOKENS / found.length));
		const parts = await Promise.all(found.map(inv => this.#collect(inv, 0, perProcess, signal)));
		return { text: parts.map((p, i) => `[${found[i]?.id}] ${p.text}`).join("\n\n"), isError: false };
	}

	async #viewImage(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
		const file = args.path;
		if (typeof file !== "string" || file.length === 0) return { text: "path is required.", isError: true };
		if (!this.#imageInput) return { text: "The reviewer model does not accept images.", isError: true };
		const ext = file.split(".").pop()?.toLowerCase() ?? "";
		const mimeType = IMAGE_TYPES[ext];
		if (!mimeType) return { text: "Unsupported image type.", isError: true };
		// Read through the sandbox like every other investigation, without the rolling output buffer.
		const quoted = `'${file.replaceAll("'", "'\\''")}'`;
		const proc = Bun.spawn(bwrapArgv(this.#cwd, `head -c ${MAX_IMAGE_BYTES + 1} -- ${quoted} | base64 -w0`), {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const kill = () => proc.kill("SIGKILL");
		signal.addEventListener("abort", kill, { once: true });
		try {
			const [data, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			if (signal.aborted) return { text: "Review ended.", isError: true };
			if (code !== 0 || data.trim().length === 0) return { text: "Image could not be read.", isError: true };
			// One byte over the limit is read on purpose, so a larger file is detected by its decoded size.
			if (Buffer.byteLength(data.trim(), "base64") > MAX_IMAGE_BYTES) return { text: "Image is too large.", isError: true };
			return { text: `Image ${file}`, image: { type: "image", data: data.trim(), mimeType }, isError: false };
		} finally {
			signal.removeEventListener("abort", kill);
		}
	}

	/** Kill and reap every investigation; idempotent. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		const all = [...this.#processes.values()];
		this.#processes.clear();
		for (const inv of all) inv.proc.kill("SIGKILL");
		await Promise.allSettled(all.map(inv => inv.exited));
	}
}

function abortPromise(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) resolve();
	else signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}
