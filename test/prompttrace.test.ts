import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { traceCommit, traceFile, traceLine } from "../src/attribution.js";
import { runHook } from "../src/capture/hooks.js";
import { endTurn, startTurn } from "../src/capture/turns.js";
import { TraceDB } from "../src/db.js";
import { exportHtml } from "../src/export.js";
import { install, uninstall } from "../src/install.js";
import { fetchNotes, linkCommit, parseNote, pushNotes } from "../src/notes.js";
import { readNote } from "../src/git.js";
import { redact } from "../src/redact.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(name = "Alice", email = "alice@example.com"): string {
  const d = mkdtempSync(join(tmpdir(), "pt-test-"));
  dirs.push(d);
  sh(d, "init", "-q", "-b", "main");
  sh(d, "config", "user.name", name);
  sh(d, "config", "user.email", email);
  sh(d, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "README.md"), "# demo\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "init");
  return d;
}

const write = (root: string, file: string, content: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
};

/** Simulate one agent turn the way the hooks would. */
function turn(db: TraceDB, prompt: string, edit: () => void, session = "s1") {
  const t = startTurn(db, { sessionId: session, agent: "claude", prompt });
  edit();
  endTurn(db, session);
  return t;
}

function commitAll(root: string, db: TraceDB, msg: string) {
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", msg);
  return linkCommit(db);
}

describe("capture + attribution", () => {
  it("attributes uncommitted lines to the prompt that wrote them", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t = turn(db, "add a greet function", () =>
      write(root, "src/a.ts", "export function greet(name: string) {\n  return `hi ${name}`;\n}\n"),
    );
    const r = traceLine(db, "src/a.ts", 2);
    expect(r.confidence).toBe("uncommitted");
    expect(r.turn?.id).toBe(t.id);
    expect(r.turn?.prompt).toBe("add a greet function");
    expect(r.diff).toContain("+  return `hi ${name}`;");
  });

  it("captures changes made via shell commands, not just edit tools", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t = turn(db, "generate the config", () => execFileSync("sh", ["-c", "printf 'port = 8080\\n' > config.toml"], { cwd: root }));
    expect(traceLine(db, "config.toml", 1).turn?.id).toBe(t.id);
  });

  it("separates two turns editing the same file", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t1 = turn(db, "create math helpers", () => write(root, "m.ts", "export const add = (a, b) => a + b;\n"));
    const t2 = turn(db, "also add subtract", () =>
      write(root, "m.ts", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n"),
    );
    expect(traceLine(db, "m.ts", 1).turn?.id).toBe(t1.id);
    expect(traceLine(db, "m.ts", 2).turn?.id).toBe(t2.id);
    expect(traceFile(db, "m.ts").map((x) => x.id)).toEqual([t1.id, t2.id]);
  });

  it("attributes closing braces to the block they close, committed or not", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t1 = turn(db, "add()", () => write(root, "f.ts", "function add(a, b) {\n  return a + b;\n}\n"));
    const t2 = turn(db, "mul()", () =>
      write(root, "f.ts", "function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n"),
    );
    const check = () => {
      expect(traceLine(db, "f.ts", 3).turn?.id).toBe(t1.id);
      expect(traceLine(db, "f.ts", 3).via_line).toBe(2);
      expect(traceLine(db, "f.ts", 7).turn?.id).toBe(t2.id);
    };
    check();
    commitAll(root, db, "funcs");
    check();
  });

  it("does not attribute human edits made between turns", () => {
    const root = repo();
    const db = new TraceDB(root);
    turn(db, "write file", () => write(root, "x.ts", "const agentLine = 1;\n"));
    write(root, "x.ts", "const agentLine = 1;\nconst humanLine = 2;\n"); // no turn open
    expect(traceLine(db, "x.ts", 2).confidence).toBe("none");
  });

  it("never touches the user's staged index", () => {
    const root = repo();
    write(root, "staged.txt", "staged\n");
    sh(root, "add", "staged.txt");
    write(root, "unstaged.txt", "not staged\n");
    const before = sh(root, "diff", "--cached", "--name-only");
    const db = new TraceDB(root);
    turn(db, "do stuff", () => write(root, "new.txt", "agent made this\n"));
    expect(sh(root, "diff", "--cached", "--name-only")).toBe(before);
    expect(sh(root, "status", "--porcelain")).toContain("?? unstaged.txt");
  });

  it("closes an interrupted turn when the next prompt arrives", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t1 = startTurn(db, { sessionId: "s", agent: "claude", prompt: "first" });
    write(root, "i.ts", "const interrupted = true;\n");
    startTurn(db, { sessionId: "s", agent: "claude", prompt: "second" }); // no Stop in between
    expect(traceLine(db, "i.ts", 1).turn?.id).toBe(t1.id);
  });

  it("reports in-progress turns", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t = startTurn(db, { sessionId: "s", agent: "claude", prompt: "working on it" });
    write(root, "w.ts", "const wip = 1;\n");
    const r = traceLine(db, "w.ts", 1);
    expect(r.confidence).toBe("in-progress");
    expect(r.turn?.id).toBe(t.id);
  });
});

describe("commits + git notes", () => {
  it("links turns to commits and writes a self-contained note", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t = turn(db, "add feature flag", () => write(root, "flags.ts", "export const NEW_UI = true;\n"));
    const linked = commitAll(root, db, "feature flag");
    expect(linked.map((n) => n.id)).toEqual([t.id]);
    const note = parseNote(readNote(root, "HEAD")!);
    expect(note[0]).toMatchObject({ id: t.id, prompt: "add feature flag", files: ["flags.ts"], author: { name: "Alice" } });
    expect(note[0].diff).toContain("+export const NEW_UI = true;");
    const r = traceLine(db, "flags.ts", 1);
    expect(r.confidence).toBe("line");
    expect(r.commit?.subject).toBe("feature flag");
    expect(traceCommit(db, "HEAD").turns[0].id).toBe(t.id);
  });

  it("does not sweep stale turns into unrelated commits", () => {
    const root = repo();
    const db = new TraceDB(root);
    turn(db, "experiment", () => write(root, "e.ts", "const experiment = 'abandoned';\n"));
    write(root, "e.ts", "const handWritten = 'by a human';\n"); // human overwrites agent work
    expect(commitAll(root, db, "human commit")).toHaveLength(0);
    expect(traceLine(db, "e.ts", 1).confidence).toBe("none");
  });

  it("links a turn split across two commits to both", () => {
    const root = repo();
    const db = new TraceDB(root);
    const t = turn(db, "touch two files", () => {
      write(root, "p.ts", "const partOne = 1;\n");
      write(root, "q.ts", "const partTwo = 2;\n");
    });
    sh(root, "add", "p.ts");
    sh(root, "commit", "-qm", "one");
    expect(linkCommit(db).map((n) => n.files)).toEqual([["p.ts"]]);
    sh(root, "add", "q.ts");
    sh(root, "commit", "-qm", "two");
    expect(linkCommit(db).map((n) => n.files)).toEqual([["q.ts"]]);
    expect(db.commitsForTurn(t.id)).toHaveLength(2);
  });

  it("redacts secrets in shared notes but keeps the raw prompt locally", () => {
    const root = repo();
    const db = new TraceDB(root);
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    turn(db, `use ANTHROPIC_API_KEY=${key} to call the api`, () => write(root, "api.ts", `const client = makeClient();\n`));
    commitAll(root, db, "api");
    const note = readNote(root, "HEAD")!;
    expect(note).not.toContain(key);
    expect(note).toContain("[REDACTED");
    expect(traceLine(db, "api.ts", 1).turn?.prompt).toContain(key);
  });
});

describe("team sharing", () => {
  it("lets a teammate see another person's prompts after fetching notes", () => {
    const bare = mkdtempSync(join(tmpdir(), "pt-remote-"));
    dirs.push(bare);
    sh(bare, "init", "-q", "--bare", "-b", "main");

    const alice = repo("Alice", "alice@example.com");
    sh(alice, "remote", "add", "origin", bare);
    const adb = new TraceDB(alice);
    const t = turn(adb, "make the login page validate emails", () =>
      write(alice, "login.ts", "export function validEmail(s: string) {\n  return /.+@.+/.test(s);\n}\n"),
    );
    commitAll(alice, adb, "email validation");
    sh(alice, "push", "-q", "origin", "main");
    pushNotes(adb, "origin");

    const bob = mkdtempSync(join(tmpdir(), "pt-bob-"));
    dirs.push(bob);
    sh(bob, "clone", "-q", bare, ".");
    sh(bob, "config", "user.name", "Bob");
    const bdb = new TraceDB(bob);
    // Even before fetching notes Bob has no turns…
    expect(traceLine(bdb, "login.ts", 2).confidence).toBe("none");
    // …after fetching, Alice's prompt shows up.
    expect(fetchNotes(bdb, "origin").turns).toBe(1);
    const r = traceLine(bdb, "login.ts", 2);
    expect(r.confidence).toBe("line");
    expect(r.turn).toMatchObject({ id: t.id, author: "Alice <alice@example.com>", origin: "imported", prompt: "make the login page validate emails" });
    expect(bdb.listTurns({ author: "alice" })).toHaveLength(1);
    expect(bdb.searchPrompts("validate emails")).toHaveLength(1);

    // Bob adds his own traced work; notes merge without clobbering Alice's.
    turn(bdb, "add a password check", () => write(bob, "pw.ts", "export const strong = (p: string) => p.length >= 12;\n"));
    commitAll(bob, bdb, "pw");
    sh(bob, "push", "-q", "origin", "main");
    pushNotes(bdb, "origin");
    sh(alice, "pull", "-q", "origin", "main");
    fetchNotes(adb, "origin");
    expect(adb.authors().map((a) => a.author_name).sort()).toEqual(["Alice", "Bob"]);
    expect(traceLine(adb, "pw.ts", 1).turn?.author).toContain("Bob");

    const html = exportHtml(adb);
    expect(html).toContain("make the login page validate emails");
    expect(html).toContain("add a password check");
  });
});

describe("hooks + install", () => {
  it("handles Claude Code / Codex hook payloads end to end", () => {
    const root = repo();
    runHook("prompt", "codex", JSON.stringify({ session_id: "abc", cwd: root, prompt: "rename foo to bar", turn_id: "t1" }));
    write(root, "foo.ts", "export const bar = 1;\n");
    runHook("tool", "codex", JSON.stringify({ session_id: "abc", cwd: root, tool_name: "apply_patch", tool_input: { command: "apply_patch ..." } }));
    runHook("stop", "codex", JSON.stringify({ session_id: "abc", cwd: root }));
    const db = new TraceDB(root);
    const r = traceLine(db, "foo.ts", 1);
    expect(r.turn).toMatchObject({ agent: "codex", prompt: "rename foo to bar" });
    expect(db.toolEvents(r.turn!.id)[0].tool).toContain("apply_patch");
  });

  it("never throws from a hook, even with garbage input", () => {
    const root = repo();
    expect(() => runHook("prompt", "claude", "{not json")).not.toThrow();
    expect(() => runHook("stop", "claude", JSON.stringify({ cwd: "/definitely/not/a/repo" }))).not.toThrow();
    expect(() => runHook("stop", "claude", JSON.stringify({ cwd: root }))).not.toThrow();
  });

  it("install merges with existing settings and uninstall cleans up", () => {
    const root = repo();
    write(root, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    install({ root, claude: true, codex: true, gitHooks: true, command: "prompttrace" });
    install({ root, claude: true, codex: true, gitHooks: true, command: "prompttrace" }); // idempotent
    const s = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(s.permissions.allow).toEqual(["Bash(ls)"]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe("prompttrace hook prompt --agent claude");
    expect(JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command).toContain("--agent codex");
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.prompttrace).toEqual({ command: "prompttrace", args: ["mcp"] });
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8").match(/\[mcp_servers\.prompttrace\]/g)).toHaveLength(1);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8").match(/<!-- prompttrace -->/g)).toHaveLength(1);
    expect(existsSync(join(root, ".claude/skills/prompt-trace/SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, ".git/hooks/post-commit"), "utf8").match(/link-commit/g)).toHaveLength(1);
    expect(sh(root, "config", "--get-all", "notes.rewriteRef").trim()).toBe("refs/notes/prompttrace");

    uninstall(root);
    const after = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(after.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(readFileSync(join(root, ".git/hooks/post-commit"), "utf8")).not.toContain("link-commit");
  });
});

describe("redact", () => {
  it.each([
    ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA", "[REDACTED_ANTHROPIC_KEY]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "[REDACTED_GITHUB_TOKEN]"],
    ["AKIAABCDEFGHIJKLMNOP", "[REDACTED_AWS_KEY]"],
    ["DATABASE_PASSWORD=hunter2hunter2", "DATABASE_PASSWORD=[REDACTED]"],
    ["postgres://user:s3cretpass@db.host/x", "postgres://user:[REDACTED]@db.host/x"],
    ["Authorization: Bearer abcdefghijklmnopqrstuv", "Authorization: Bearer [REDACTED]"],
  ])("scrubs %s", (input, expected) => {
    expect(redact(input)).toContain(expected);
  });
  it("leaves normal prompts alone", () => {
    const p = "refactor the token parser in lexer.ts to handle unicode";
    expect(redact(p)).toBe(p);
  });
});
