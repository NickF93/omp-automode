import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { editTargets, gate, parseWordOnlySequence } from "../src/gate";
import type { ShellRule } from "../src/settings";

let root: string;
let cwd: string;
let outside: string;

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "automode-gate-"));
	cwd = path.join(root, "project");
	outside = path.join(root, "elsewhere");
	mkdirSync(path.join(cwd, "src"), { recursive: true });
	mkdirSync(path.join(cwd, ".git"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(cwd, "data.zip"), "zip");
	// A file literally named "file" must not turn a file:// URL into a member selector.
	writeFileSync(path.join(cwd, "file"), "x");
	symlinkSync(outside, path.join(cwd, "link-out"));
	symlinkSync(path.join(cwd, ".git"), path.join(cwd, "gitlink"));
	// A directory name that starts like a hashline wrapper, pointing outside.
	symlinkSync(outside, path.join(cwd, "[evil"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

type ToolInfo = Parameters<typeof gate>[0]["toolInfo"];
const noTools: ToolInfo = () => undefined;
const run = (toolName: string, input: Record<string, unknown>, rules: ShellRule[] = [], toolInfo = noTools) =>
	gate({ toolName, input, cwd, rules, toolInfo }).kind;

describe("word-only shell parsing", () => {
	test("splits literal sequences on && || ; | and newlines with quote removal", () => {
		expect(parseWordOnlySequence(`git status && echo "a b" | wc -l; ls 'x y'\nnpm test || true`)).toEqual([
			["git", "status"],
			["echo", "a b"],
			["wc", "-l"],
			["ls", "x y"],
			["npm", "test"],
			["true"],
		]);
	});

	test("keeps empty quoted arguments and concatenated quoting as one word", () => {
		expect(parseWordOnlySequence(`printf '' a"b c"'d'`)).toEqual([["printf", "", "ab cd"]]);
	});

	test("quoted operators are literal text, not separators", () => {
		expect(parseWordOnlySequence(`echo '&&' "|" ';'`)).toEqual([["echo", "&&", "|", ";"]]);
	});

	test.each([
		["variable expansion", "echo $HOME"],
		["command substitution", "echo $(whoami)"],
		["backticks", "echo `id`"],
		["expansion inside double quotes", 'echo "$X"'],
		["redirection", "echo hi > out.txt"],
		["input redirection", "cat < in"],
		["glob", "rm *.txt"],
		["brace expansion", "touch {a,b}"],
		["tilde", "ls ~/x"],
		["assignment prefix", "FOO=1 make"],
		["background", "sleep 1 &"],
		["subshell", "(cd x && ls)"],
		["comment", "ls # note"],
		["pipe stderr", "a |& b"],
		["dangling operator", "make &&"],
		["leading operator", "&& make"],
		["double semicolon", "a ;; b"],
		["unterminated quote", "echo 'x"],
		["nested script", "bash -c 'rm -rf /' && $(true)"],
		["reserved word time", "time rm -rf build"],
		["control flow keyword", "if true; then rm x; fi"],
	])("%s is not literal", (_name, command) => {
		expect(parseWordOnlySequence(command)).toBeUndefined();
	});

	test("an assignment-looking argument after the command name stays literal", () => {
		expect(parseWordOnlySequence("make CC=clang")).toEqual([["make", "CC=clang"]]);
	});
});

describe("shell rules", () => {
	const rules: ShellRule[] = [
		{ prefix: ["git", "status"], decision: "allow" },
		{ prefix: ["npm", "test"], decision: "allow" },
		{ prefix: ["git"], decision: "allow" },
		{ prefix: ["git", "push"], decision: "forbidden" },
	];

	test("all components allowed skips review", () => {
		expect(run("bash", { command: "git status && npm test -- --watch=false" }, rules)).toBe("skip");
	});

	test("forbidden wins over an overlapping allow in any component", () => {
		const result = gate({ toolName: "bash", input: { command: "git status; git push origin main" }, cwd, rules, toolInfo: noTools });
		expect(result.kind).toBe("forbidden");
		expect(result.kind === "forbidden" && result.command).toEqual(["git", "push", "origin", "main"]);
	});

	test("one unmatched component sends the whole command to review", () => {
		expect(run("bash", { command: "git status && curl https://example.com" }, rules)).toBe("review");
	});

	test("prefix matches whole argv words, not string prefixes", () => {
		expect(run("bash", { command: "npm testing" }, [{ prefix: ["npm", "test"], decision: "allow" }])).toBe("review");
		expect(run("bash", { command: "gitk" }, [{ prefix: ["git"], decision: "allow" }])).toBe("review");
	});

	test("opaque syntax is reviewed even when its words would match", () => {
		expect(run("bash", { command: "git status > /dev/null" }, rules)).toBe("review");
	});

	test("no rules means review, never denial", () => {
		expect(run("bash", { command: "ls" })).toBe("review");
	});
});

describe("tool mapping", () => {
	test("read-only and control tools skip", () => {
		for (const tool of ["read", "grep", "glob", "web_search", "ask", "todo", "wait", "task"]) {
			expect(run(tool, {})).toBe("skip");
		}
	});

	test("eval, debug, browser-capable and unknown tools are reviewed", () => {
		for (const tool of ["eval", "debug", "computer", "github", "some_extension_tool"]) {
			expect(run(tool, {})).toBe("review");
		}
	});

	test("MCP tools skip only with an explicit read-only hint", () => {
		const mcp: Record<string, { mcpServerName: string; mcpReadOnlyHint?: boolean }> = {
			mcp__docs_search: { mcpServerName: "docs", mcpReadOnlyHint: true },
			mcp__docs_write: { mcpServerName: "docs", mcpReadOnlyHint: false },
			mcp__docs_other: { mcpServerName: "docs" },
		};
		const tools: ToolInfo = name => mcp[name];
		expect(run("mcp__docs_search", {}, [], tools)).toBe("skip");
		expect(run("mcp__docs_write", {}, [], tools)).toBe("review");
		expect(run("mcp__docs_other", {}, [], tools)).toBe("review");
	});

	test("LSP queries skip; edits that can reach other files are reviewed", () => {
		expect(run("lsp", { action: "hover", file: "src/a.ts" })).toBe("skip");
		expect(run("lsp", { action: "code_actions", file: "src/a.ts" })).toBe("skip");
		expect(run("lsp", { action: "rename", file: "src/a.ts", new_name: "b" })).toBe("review");
		// File renames also rewrite references the language server chooses.
		expect(run("lsp", { action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" })).toBe("review");
	});
});

describe("write and edit targets", () => {
	test("local writes inside cwd skip; outside, protected and remote targets are reviewed", () => {
		expect(run("write", { path: "src/new.ts", content: "x" })).toBe("skip");
		expect(run("write", { path: "brand/new/dir/file.ts", content: "x" })).toBe("skip");
		expect(run("write", { path: path.join(outside, "x.txt"), content: "x" })).toBe("review");
		expect(run("write", { path: ".git/config", content: "x" })).toBe("review");
		expect(run("write", { path: "src/../.git/hooks/pre-commit", content: "x" })).toBe("review");
		expect(run("write", { path: ".omp/config.yml", content: "x" })).toBe("review");
		expect(run("write", { path: "sub/.agents/skill.md", content: "x" })).toBe("review");
		expect(run("write", { path: "ssh://host/etc/x", content: "x" })).toBe("review");
	});

	test("hashline-wrapped write paths are judged by the path the host writes", () => {
		expect(run("write", { path: "[.git/hooks/pre-commit]", content: "x" })).toBe("review");
		expect(run("write", { path: "[../elsewhere/x.txt#ABCD]", content: "x" })).toBe("review");
		expect(run("write", { path: "[ssh://host/etc/x]", content: "x" })).toBe("review");
		expect(run("write", { path: "[src/ok.ts#1A2B]", content: "x" })).toBe("skip");
	});

	test("a write path is unwrapped once, as the host writes it", () => {
		// The host writes `[evil/x`, through the symlink `[evil` out of cwd.
		expect(run("write", { path: "[[evil/x]]", content: "x" })).toBe("review");
	});

	test("edit header paths are stripped once, as the host's event normalization strips them", () => {
		expect(editTargets({ input: "[[evil/x]#1A2B]\nPUT 1.=1:\n+x" })).toEqual(["[evil/x]"]);
		expect(run("edit", { input: "[[evil/x]#1A2B]\nPUT 1.=1:\n+x" })).toBe("review");
	});

	test("host path shorthands are normalized before containment", () => {
		expect(run("write", { path: `@${path.join(outside, "x.txt")}`, content: "x" })).toBe("review");
		expect(run("write", { path: `:${path.join(outside, "x.txt")}`, content: "x" })).toBe("review");
		expect(run("write", { path: `file://${path.join(cwd, ".git", "config")}`, content: "x" })).toBe("review");
		expect(run("write", { path: `file://${path.join(cwd, "src", "ok.ts")}`, content: "x" })).toBe("skip");
		expect(run("write", { path: "@local://PLAN.md", content: "x" })).toBe("skip");
		expect(run("write", { path: `file://${path.join(outside, "rc")}`, content: "x" })).toBe("review");
		expect(run("write", { path: `FILE://${path.join(cwd, ".git", "hooks", "pre-commit")}`, content: "x" })).toBe("review");
	});

	test("patch-mode renames are targets", () => {
		expect(run("edit", { path: "src/a.ts", edits: [{ op: "update", rename: ".git/hooks/pre-commit", diff: "" }] })).toBe("review");
		expect(run("edit", { path: "src/a.ts", edits: [{ op: "update", rename: "src/b.ts", diff: "" }] })).toBe("skip");
	});

	test("symlinked ancestors resolve to their real location", () => {
		expect(run("write", { path: "link-out/escape.txt", content: "x" })).toBe("review");
		expect(run("write", { path: "gitlink/config", content: "x" })).toBe("review");
	});

	test("archive member selectors resolve to the backing file", () => {
		expect(run("write", { path: "data.zip:inner/file.txt", content: "x" })).toBe("skip");
	});

	test("a selector-looking path is reviewed if its literal reading escapes cwd or reaches .git", () => {
		writeFileSync(path.join(cwd, "README.md"), "x");
		expect(run("write", { path: "README.md:/../../../../../../../../tmp/x", content: "x" })).toBe("review");
		expect(run("write", { path: "README.md:/../.git/hooks/pre-commit", content: "x" })).toBe("review");
		expect(run("edit", { path: "README.md:/../.git/hooks/pre-commit", edits: [] })).toBe("review");
	});

	test("local, agent and proc protocol writes are accepted exemptions", () => {
		expect(run("write", { path: "local://PLAN.md", content: "x" })).toBe("skip");
		expect(run("write", { path: "agent://Worker", content: "x" })).toBe("skip");
		expect(run("write", { path: "proc://bg_1/kill" })).toBe("skip");
	});

	test("hashline edits are reviewed if any header or MV destination leaves cwd", () => {
		expect(run("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[src/b.ts#3C4D]\nCUT 2.=2" })).toBe("skip");
		expect(run("edit", { input: "[src/a.ts#1A2B]\nMV ../elsewhere/a.ts" })).toBe("review");
		expect(run("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[.git/HEAD#1111]\nPUT 1.=1:\n+y" })).toBe("review");
		expect(editTargets({ input: '["src/with space.ts"#1A2B]\nMV "src/moved here.ts"' })).toEqual([
			"src/with space.ts",
			"src/moved here.ts",
		]);
	});

	test("apply-patch style edits include added, moved and deleted files", () => {
		const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ../elsewhere/a.ts\n*** End Patch";
		expect(run("edit", { input: patch })).toBe("review");
	});

	test("an edit with no identifiable target is reviewed rather than guessed", () => {
		expect(run("edit", { input: "PUT 1.=1:\n+x" })).toBe("review");
	});

	test("ast_edit globs are checked by their static base and protected names", () => {
		expect(run("ast_edit", { paths: ["src/**/*.ts"] })).toBe("skip");
		expect(run("ast_edit", { paths: ["../elsewhere/**/*.ts"] })).toBe("review");
		expect(run("ast_edit", { paths: [".git/**"] })).toBe("review");
	});
});

describe("mounted devices", () => {
	test("device calls get the same gate as the direct call and report the inner tool", () => {
		expect(gate({ toolName: "write", input: { path: "xd://lsp", content: JSON.stringify({ action: "hover", file: "a.ts" }) }, cwd, rules: [], toolInfo: noTools })).toEqual({
			kind: "skip",
			xdInner: "lsp",
		});
		const reviewed = gate({ toolName: "write", input: { path: "xd://eval", content: JSON.stringify({ code: "1" }) }, cwd, rules: [], toolInfo: noTools });
		expect(reviewed).toEqual({ kind: "review", xdInner: "eval" });
	});

	test("there is no blanket xd:// write exemption", () => {
		expect(run("write", { path: "xd://some_mcp_tool", content: "{}" })).toBe("review");
		expect(run("write", { path: "xd://eval", content: "not json" })).toBe("review");
	});

	test("plan proposal and preview resolution devices are control, not reviewed", () => {
		for (const device of ["propose", "resolve", "reject"]) {
			expect(run("write", { path: `xd://${device}`, content: "capitalize-helper" })).toBe("skip");
		}
		expect(run("write", { path: "xd://some_device", content: "plain text" })).toBe("review");
	});

	test("documentation requests are read-only", () => {
		expect(run("write", { path: "xd://eval", content: "?" })).toBe("skip");
		expect(run("write", { path: "xd://eval", content: "" })).toBe("skip");
	});
});
