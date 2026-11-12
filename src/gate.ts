/**
 * Deterministic gate: decides, without inference, whether a tool call is
 * skipped, forbidden by a shell rule, or sent to the reviewer.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellRule } from "./settings";
import { isRecord } from "./state";

/** Metadata the gate reads from the host's live tool registry. */
export interface GateToolInfo {
	name: string;
	description?: string;
	mcpServerName?: string;
	mcpReadOnlyHint?: boolean;
	source?: string;
}

export interface GateInput {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	rules: readonly ShellRule[];
	tools: ReadonlyMap<string, GateToolInfo>;
}

export type GateResult =
	| { kind: "skip"; reason: string; xdInner?: string }
	| { kind: "forbidden"; rule: ShellRule; command: string[]; xdInner?: string }
	| { kind: "review"; xdInner?: string };

/** Read-only, search and session/agent control tools. A child's own calls still pass through the gate. */
const SKIP_TOOLS: Record<string, true> = toRecord([
	"read",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"web_search",
	"ask",
	"todo",
	"wait",
	"task",
	"think",
	"yield",
	"goal",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"recall",
	"reflect",
]);

const LSP_QUERY_ACTIONS: Record<string, true> = toRecord([
	"diagnostics",
	"definition",
	"references",
	"hover",
	"symbols",
	"type_definition",
	"implementation",
	"status",
	"reload",
	"capabilities",
]);

const PROTECTED_COMPONENTS: Record<string, true> = toRecord([".git", ".agents", ".omp"]);
/** Protocols whose writes are accepted without review, including their control effects. */
const EXEMPT_WRITE_PROTOCOLS: Record<string, true> = toRecord(["local", "agent", "proc"]);
/** Device writes that only show documentation. */
const DEVICE_HELP_RE = /^\s*(\?|help)?\s*$/i;
/** Plain-text control devices: apply or reject a preview gated when it was staged, propose a plan, report a tool issue. */
const CONTROL_DEVICES: Record<string, true> = toRecord(["resolve", "reject", "propose", "report_issue"]);

const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

function toRecord(keys: readonly string[]): Record<string, true> {
	return Object.fromEntries(keys.map(key => [key, true] as const));
}

export function gate(input: GateInput): GateResult {
	const { toolName, cwd } = input;
	if (SKIP_TOOLS[toolName]) return { kind: "skip", reason: "read-only or control tool" };
	switch (toolName) {
		case "bash":
			return gateBash(input);
		case "write":
			return gateWrite(input);
		case "edit":
			return gateLocalTargets(editTargets(input.input), cwd);
		case "ast_edit":
			return gateLocalTargets(astEditTargets(input.input), cwd);
		case "lsp":
			return gateLsp(input.input, cwd);
	}
	const info = input.tools.get(toolName);
	const isMcp = info !== undefined && (info.mcpServerName !== undefined || info.source === "mcp");
	if (isMcp && info.mcpReadOnlyHint === true) return { kind: "skip", reason: "MCP read-only hint" };
	return { kind: "review" };
}

// ---------------------------------------------------------------------------
// write and mounted devices
// ---------------------------------------------------------------------------

/**
 * Strip a hashline header wrapper (`[path]`, `[path#1A2B]`) exactly as the host
 * does before it routes a write, so the gate judges the path that is written.
 */
export function unwrapHeaderPath(target: string): string {
	const trimmed = target.trimEnd();
	if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") return target;
	const inner = trimmed.slice(1, -1);
	const tag = HASHLINE_TAG_RE.exec(inner);
	const pathPart = tag ? inner.slice(0, tag.index) : inner;
	if (pathPart.length === 0 || (!tag && pathPart.includes("#"))) return target;
	return pathPart;
}

function gateWrite(input: GateInput): GateResult {
	const raw = input.input.path;
	if (typeof raw !== "string" || raw.length === 0) return { kind: "review" };
	const unwrapped = unwrapHeaderPath(raw);
	// `@scheme://…` is the host's shorthand for an internal URL.
	const target = /^@[a-z][a-z0-9+.-]*:\/\//i.test(unwrapped) ? unwrapped.slice(1) : unwrapped;
	const scheme = URL_SCHEME_RE.exec(target)?.[1]?.toLowerCase();
	if (scheme === "file") return gateLocalTargets([target], input.cwd);
	if (scheme === "xd") return gateDevice(input, target.slice("xd://".length));
	if (scheme && EXEMPT_WRITE_PROTOCOLS[scheme]) return { kind: "skip", reason: `${scheme}:// write` };
	if (scheme) return { kind: "review" };
	return gateLocalTargets([target], input.cwd);
}

/**
 * `write xd://<tool>` runs the canonical tool with the JSON content as its
 * arguments. Gate it exactly like the direct call; the host emits the inner
 * call again with the same tool-call id, which the caller deduplicates.
 */
function gateDevice(input: GateInput, rest: string): GateResult {
	const name = rest.split("/")[0] ?? "";
	const content = typeof input.input.content === "string" ? input.input.content : "";
	if (!name) return { kind: "review" };
	if (DEVICE_HELP_RE.test(content)) return { kind: "skip", reason: "device documentation" };
	if (CONTROL_DEVICES[name]) return { kind: "skip", reason: `xd://${name} control device`, xdInner: name };
	let args: unknown;
	try {
		args = JSON.parse(content);
	} catch {
		return { kind: "review" };
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) return { kind: "review" };
	if (name === "write" || name === "read") return { kind: "review" };
	const inner = gate({ ...input, toolName: name, input: args as Record<string, unknown> });
	return { ...inner, xdInner: name };
}

// ---------------------------------------------------------------------------
// local file targets
// ---------------------------------------------------------------------------

/** Archive and SQLite selectors address a member of an existing backing file. */
/**
 * Every file a target can name: the literal path and, when the text before the
 * first `:` is an existing file, that file as an archive or database whose member
 * is addressed. The host decides between them by format, so the gate requires
 * all interpretations to be local and unprotected.
 */
function candidateFiles(raw: string, cwd: string): string[] {
	// Decode host spellings (file:// URLs, @/ and : prefixes) before looking for a member selector.
	const target = expandHome(raw);
	const files = [resolveAgainst(target, cwd)];
	const colon = target.indexOf(":", 1);
	if (colon > 0) {
		const candidate = resolveAgainst(target.slice(0, colon), cwd);
		try {
			if (statSync(candidate).isFile()) files.push(candidate);
		} catch {
			// not an existing file: only the literal path applies
		}
	}
	return files;
}

/** Host path spellings: stray leading `:`, `@/`/`@~` shorthands, `file://` URLs and `~`. */
function expandHome(p: string): string {
	let value = /^:(?=[/\\~]|\.\.?[/\\])/.test(p) ? p.slice(1) : p;
	if (value.startsWith("@/") || value === "@~" || value.startsWith("@~/")) value = value.slice(1);
	if (value.toLowerCase().startsWith("file://")) {
		try {
			value = fileURLToPath(value);
		} catch {
			// not a valid file URL: resolve it literally
		}
	}
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function resolveAgainst(p: string, cwd: string): string {
	return path.resolve(cwd, expandHome(p));
}

/** Resolve symlinks of the longest existing ancestor and keep the remainder. */
export function realTarget(absolute: string): string {
	let current = absolute;
	const rest: string[] = [];
	for (;;) {
		if (existsSync(current)) {
			try {
				return path.join(realpathSync(current), ...rest.reverse());
			} catch {
				return path.join(current, ...rest.reverse());
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return absolute;
		rest.push(path.basename(current));
		current = parent;
	}
}

/** True when the target lies inside cwd and outside protected directories. */
export function isLocalUnprotected(target: string, cwd: string): boolean {
	const scheme = URL_SCHEME_RE.exec(target)?.[1]?.toLowerCase();
	if (scheme && scheme !== "file") return false;
	const root = realTarget(path.resolve(cwd));
	return candidateFiles(target, cwd).every(file => {
		const rel = path.relative(root, realTarget(file));
		if (rel === "") return true;
		if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
		return !rel.split(path.sep).some(part => PROTECTED_COMPONENTS[part]);
	});
}

function gateLocalTargets(targets: string[] | undefined, cwd: string): GateResult {
	if (!targets || targets.length === 0) return { kind: "review" };
	const remote: string[] = [];
	for (const raw of targets) {
		const unwrapped = unwrapHeaderPath(raw);
		const target = /^@[a-z][a-z0-9+.-]*:\/\//i.test(unwrapped) ? unwrapped.slice(1) : unwrapped;
		const scheme = URL_SCHEME_RE.exec(target)?.[1]?.toLowerCase();
		if (scheme && EXEMPT_WRITE_PROTOCOLS[scheme]) continue;
		if (!isLocalUnprotected(target, cwd)) remote.push(target);
	}
	if (remote.length > 0) return { kind: "review" };
	return { kind: "skip", reason: "local edit inside the working directory" };
}

const PATCH_MARKER_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/;
const MV_RE = /^MV\s+(.+?)\s*$/;
const HASHLINE_HEADER_RE = /^\[(.+)\]$/;
const LEGACY_HEADER_RE = /^¶+(.+)$/;
const HASHLINE_TAG_RE = /#[0-9a-fA-F]{4}$/;

function unquote(s: string): string {
	const first = s[0];
	if (s.length >= 2 && (first === '"' || first === "'") && s.endsWith(first)) return s.slice(1, -1);
	return s;
}

/** Every source and destination an edit call can touch; undefined when none can be identified. */
export function editTargets(input: Record<string, unknown>): string[] | undefined {
	const targets: string[] = [];
	for (const key of ["path", "_path", "move", "moveTo", "rename"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) targets.push(value);
	}
	const paths = input.paths;
	if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string" && p.length > 0) targets.push(p);
	// Patch mode: every entry may rename its file.
	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const entry of edits) {
			if (!isRecord(entry)) continue;
			for (const key of ["rename", "move", "path"]) {
				const value = entry[key];
				if (typeof value === "string" && value.length > 0) targets.push(value);
			}
		}
	}
	for (const key of ["input", "_input"]) {
		const body = input[key];
		if (typeof body !== "string") continue;
		for (const rawLine of body.replace(/^\uFEFF/, "").split("\n")) {
			const line = rawLine.replace(/\r$/, "");
			const header = HASHLINE_HEADER_RE.exec(line) ?? LEGACY_HEADER_RE.exec(line.trimStart());
			if (header?.[1]) {
				targets.push(unquote(header[1].trim().replace(HASHLINE_TAG_RE, "")));
				continue;
			}
			const mv = MV_RE.exec(line) ?? PATCH_MARKER_RE.exec(line);
			if (mv?.[1]) targets.push(unquote(mv[1]));
		}
	}
	return targets.length > 0 ? [...new Set(targets)] : undefined;
}

const GLOB_CHAR_RE = /[*?[\]{}]/;

/** ast_edit takes globs: use each pattern's static directory and refuse protected names anywhere. */
function astEditTargets(input: Record<string, unknown>): string[] | undefined {
	const raw = input.paths ?? input.path;
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	const targets: string[] = [];
	for (const pattern of list) {
		if (typeof pattern !== "string" || pattern.length === 0) return undefined;
		const parts = pattern.split("/");
		if (parts.some(part => PROTECTED_COMPONENTS[part])) return undefined;
		const firstGlob = parts.findIndex(part => GLOB_CHAR_RE.test(part));
		const base = firstGlob < 0 ? pattern : parts.slice(0, firstGlob).join("/") || ".";
		targets.push(base);
	}
	return targets.length > 0 ? targets : undefined;
}

function gateLsp(input: Record<string, unknown>, cwd: string): GateResult {
	const action = typeof input.action === "string" ? input.action.toLowerCase() : "";
	if (LSP_QUERY_ACTIONS[action]) return { kind: "skip", reason: "LSP query" };
	if (action === "code_actions" && input.apply !== true) return { kind: "skip", reason: "LSP query" };
	// Renames (including file renames, which rewrite references), applied code actions and raw requests can edit files beyond the named ones.
	return { kind: "review" };
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function gateBash(input: GateInput): GateResult {
	const command = input.input.command;
	if (typeof command !== "string") return { kind: "review" };
	const commands = parseWordOnlySequence(command);
	if (!commands) return { kind: "review" };
	return evaluateRules(commands, input.rules);
}

export function evaluateRules(commands: string[][], rules: readonly ShellRule[]): GateResult {
	for (const argv of commands) {
		const forbidden = rules.find(rule => rule.decision === "forbidden" && matchesPrefix(argv, rule.prefix));
		if (forbidden) return { kind: "forbidden", rule: forbidden, command: argv };
	}
	const allowed = commands.every(argv =>
		rules.some(rule => rule.decision === "allow" && matchesPrefix(argv, rule.prefix)),
	);
	return allowed && commands.length > 0 ? { kind: "skip", reason: "allowed by shell rule" } : { kind: "review" };
}

function matchesPrefix(argv: string[], prefix: readonly string[]): boolean {
	return prefix.length > 0 && argv.length >= prefix.length && prefix.every((word, i) => argv[i] === word);
}

const OPERATORS = ["&&", "||", ";", "|", "\n"] as const;
type Operator = (typeof OPERATORS)[number];
type Token = { word: string } | { op: Operator };

/** Characters that make an unquoted word depend on shell interpretation. */
const NON_LITERAL_CHARS = "<>&()`$*?[]{}";

/**
 * Lex literal words and sequence operators. Undefined when the text needs any
 * other shell interpretation: expansions, globs, redirections, substitutions,
 * assignments, grouping, comments, history or background execution.
 */
function lexLiteralWords(source: string): Token[] | undefined {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) tokens.push({ word });
		word = "";
		inWord = false;
	};
	let i = 0;
	while (i < source.length) {
		const ch = source[i] as string;
		if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
			i++;
			continue;
		}
		const op = OPERATORS.find(candidate => source.startsWith(candidate, i));
		if (op) {
			if (op === "|" && source[i + 1] === "&") return undefined;
			endWord();
			tokens.push({ op });
			i += op.length;
			continue;
		}
		if (NON_LITERAL_CHARS.includes(ch)) return undefined;
		if (!inWord && (ch === "#" || ch === "~" || ch === "!" || ch === "=")) return undefined;
		if (ch === "=" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
			// NAME=value as a command's first word is an assignment.
			const last = tokens[tokens.length - 1];
			if (!last || "op" in last) return undefined;
		}
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) return undefined;
			if (next !== "\n") {
				word += next;
				inWord = true;
			}
			i += 2;
			continue;
		}
		if (ch === "'") {
			const end = source.indexOf("'", i + 1);
			if (end < 0) return undefined;
			word += source.slice(i + 1, end);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			for (;;) {
				const c = source[j];
				if (c === undefined) return undefined;
				if (c === '"') break;
				if (c === "$" || c === "`") return undefined;
				if (c === "\\") {
					const next = source[j + 1];
					if (next === undefined) return undefined;
					if (next !== "\n") word += '"\\$`'.includes(next) ? next : `\\${next}`;
					j += 2;
					continue;
				}
				word += c;
				j++;
			}
			inWord = true;
			i = j + 1;
			continue;
		}
		word += ch;
		inWord = true;
		i++;
	}
	endWord();
	return tokens;
}

/**
 * Parse a command made only of literal words joined by `&&`, `||`, `;`, `|`
 * or newlines into each command's argv. Undefined is not a ban: anything the
 * parser cannot prove literal goes to review.
 */
/** Shell reserved words and prefixes that turn the following words into syntax rather than an argv. */
const RESERVED_COMMAND_WORDS: Record<string, true> = toRecord([
	"if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
	"function", "select", "time", "coproc", "in", "[[", "]]", "!", "{", "}",
]);

export function parseWordOnlySequence(source: string): string[][] | undefined {
	const tokens = lexLiteralWords(source);
	if (!tokens) return undefined;
	const commands: string[][] = [];
	let current: string[] = [];
	let needCommand = false;
	for (const token of tokens) {
		if ("word" in token) {
			current.push(token.word);
			continue;
		}
		if (current.length > 0) {
			commands.push(current);
			current = [];
			needCommand = token.op !== ";" && token.op !== "\n";
			continue;
		}
		// An operator with no command before it: only blank lines are harmless.
		if (token.op !== "\n") return undefined;
	}
	if (current.length > 0) commands.push(current);
	else if (needCommand) return undefined;
	// A reserved word in command position is grammar, not a program name.
	if (commands.some(argv => RESERVED_COMMAND_WORDS[argv[0] as string])) return undefined;
	return commands.length > 0 ? commands : undefined;
}
