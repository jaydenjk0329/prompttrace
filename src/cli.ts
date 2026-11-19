#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Command } from "commander";
import { traceCommit, traceFile, traceLine, traceRange, summarize, type LineTrace, type TurnSummary } from "./attribution.js";
import { runHook, type HookEvent } from "./capture/hooks.js";
import { TraceDB } from "./db.js";
import { exportHtml } from "./export.js";
import { repoRelative, repoRoot } from "./git.js";
import { install, uninstall } from "./install.js";
import { fetchNotes, importNotes, linkCommit, pushNotes } from "./notes.js";

const program = new Command();
program.name("prompttrace").description("Trace which coding-agent prompt produced which code change.").version("0.1.0");

function openDb(cwd = process.cwd()): TraceDB {
  const root = repoRoot(cwd);
  if (!root) {
    console.error("prompttrace: not inside a git repository");
    process.exit(1);
  }
  return new TraceDB(root);
}

const c = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

const oneLine = (s: string, n = 100) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

function printTurnHeader(t: TurnSummary): void {
  const commits = t.commits.length ? t.commits.map((x) => x.slice(0, 8)).join(",") : "uncommitted";
  console.log(`${c.cyan(t.id.slice(0, 8))} ${c.bold(t.author)} ${c.dim(`${t.agent} · ${new Date(t.started_at).toLocaleString()} · ${commits}`)}`);
}

function printDiff(diff: string): void {
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) console.log(c.green(l));
    else if (l.startsWith("-") && !l.startsWith("---")) console.log(c.red(l));
    else if (l.startsWith("@@")) console.log(c.cyan(l));
    else console.log(l);
  }
}

function printLineTrace(r: LineTrace, showDiff: boolean): void {
  console.log(`${c.bold(`${r.file}:${r.line}`)}  ${c.dim(oneLine(r.content, 80))}`);
  if (!r.turn) {
    const who = r.commit ? `commit ${r.commit.sha.slice(0, 8)} by ${r.commit.author} — "${r.commit.subject}"` : "uncommitted";
    console.log(`  no recorded prompt (${who})`);
    return;
  }
  console.log(`  confidence: ${r.confidence}${r.via_line ? c.dim(` (via line ${r.via_line})`) : ""}`);
  process.stdout.write("  ");
  printTurnHeader(r.turn);
  console.log("\n" + r.turn.prompt.split("\n").map((l) => "  > " + l).join("\n") + "\n");
  if (r.alternatives.length) console.log(c.dim(`  also added identical content: ${r.alternatives.map((a) => a.id.slice(0, 8)).join(", ")}`));
  if (showDiff && r.diff) printDiff(r.diff);
}

program
  .command("install")
  .description("Set up capture hooks, the MCP server and the skill in this repo (defaults to --claude --codex --git-hooks)")
  .option("--claude", "Claude Code hooks (.claude/settings.json), .mcp.json, skill")
  .option("--codex", "Codex hooks (.codex/hooks.json), .codex/config.toml MCP entry, AGENTS.md")
  .option("--git-hooks", "post-commit hook that attaches prompts to commits as git notes")
  .option("--local", "Claude: write .claude/settings.local.json (just you) instead of settings.json (whole team)")
  .option("--command <cmd>", "Command hooks should run instead of auto-detected prompttrace")
  .action((o) => {
    const db = openDb();
    const all = !o.claude && !o.codex && !o.gitHooks;
    const log = install({
      root: db.root,
      claude: all || o.claude,
      codex: all || o.codex,
      gitHooks: all || o.gitHooks,
      local: o.local,
      command: o.command,
    });
    db.close();
    for (const l of log) console.log("✓ " + l);
    const share = [...(all || o.claude ? [".claude/", ".mcp.json"] : []), ...(all || o.codex ? [".codex/", "AGENTS.md"] : [])];
    if (share.length && !o.local) console.log(c.dim(`\nCommit ${share.join(", ")} so teammates capture their prompts too.`));
    if (all || o.gitHooks) console.log(c.dim("Each teammate runs `prompttrace install --git-hooks` once (git hooks aren't committed)."));
  });

program
  .command("uninstall")
  .description("Remove prompttrace hooks and MCP registration from this repo")
  .action(() => {
    const db = openDb();
    for (const l of uninstall(db.root)) console.log("✓ " + l);
    db.close();
  });

program
  .command("hook <event>")
  .description("Hook entry point (called by the agent, reads JSON on stdin): prompt | tool | stop")
  .option("--agent <agent>", "claude | codex", "claude")
  .action((event: string, o) => {
    if (["prompt", "tool", "stop"].includes(event)) runHook(event as HookEvent, o.agent);
    process.exit(0);
  });

program
  .command("link-commit [sha]")
  .description("Attach recorded prompts to a commit as a git note (run by the post-commit hook)")
  .action((sha?: string) => {
    const db = openDb();
    const linked = linkCommit(db, sha ?? "HEAD");
    db.close();
    if (process.stdout.isTTY) console.log(`linked ${linked.length} turn(s)`);
  });

program
  .command("blame <target>")
  .description("Which prompt produced this code? target = file | file:line | file:start-end")
  .option("--diff", "show the turn's diff")
  .option("--json", "machine-readable output")
  .action((target: string, o) => {
    const db = openDb();
    const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(target)!;
    const file = repoRelative(db.root, process.cwd(), m[1]);
    if (m[2] && !m[3]) {
      const r = traceLine(db, file, Number(m[2]));
      o.json ? console.log(JSON.stringify(r, null, 2)) : printLineTrace(r, !!o.diff);
    } else if (m[2] && m[3]) {
      const r = traceRange(db, file, Number(m[2]), Number(m[3]));
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else
        for (const l of r.lines)
          console.log(`${c.dim(String(l.line).padStart(5))} ${l.turn ? c.cyan(l.turn.id.slice(0, 8)) : "        "} ${c.dim(l.turn ? oneLine(l.turn.prompt, 40).padEnd(40) : "".padEnd(40))} │ ${l.content}`);
    } else {
      const turns = traceFile(db, file);
      if (o.json) console.log(JSON.stringify(turns, null, 2));
      else if (!turns.length) console.log("no recorded prompts touched " + file);
      else
        for (const t of turns) {
          printTurnHeader(t);
          console.log("  " + oneLine(t.prompt, 120));
        }
    }
    db.close();
  });

program
  .command("log")
  .description("Browse recorded prompts (yours and teammates'), newest first")
  .option("-a, --author <who>", "filter by name/email substring")
  .option("--agent <agent>", "claude | codex | mcp")
  .option("-f, --file <file>", "only turns that changed this file")
  .option("--since <iso>", "ISO timestamp")
  .option("-n, --limit <n>", "max turns", "30")
  .option("--json", "machine-readable output")
  .action((o) => {
    const db = openDb();
    importNotes(db);
    const turns = db.listTurns({
      author: o.author,
      agent: o.agent,
      since: o.since,
      file: o.file ? repoRelative(db.root, process.cwd(), o.file) : undefined,
      limit: Number(o.limit),
    });
    if (o.json) console.log(JSON.stringify(turns.map((t) => ({ ...summarize(db, t), files: db.filesForTurn(t.id) })), null, 2));
    else
      for (const t of turns) {
        printTurnHeader(summarize(db, t));
        console.log("  " + oneLine(t.origin === "local" ? t.prompt : t.prompt_redacted, 120));
        const files = db.filesForTurn(t.id);
        if (files.length) console.log(c.dim("  " + files.join(", ")));
        console.log();
      }
    db.close();
  });

program
  .command("show <turn>")
  .description("Show a turn's full prompt, tools used and diff (id prefix ok)")
  .option("--json", "machine-readable output")
  .action((id: string, o) => {
    const db = openDb();
    const t = db.getTurn(id);
    if (!t) {
      console.error(`no turn matching ${id}`);
      process.exit(1);
    }
    const s = summarize(db, t);
    if (o.json) console.log(JSON.stringify({ ...s, files: db.filesForTurn(t.id), tools: db.toolEvents(t.id), diff: t.diff }, null, 2));
    else {
      printTurnHeader(s);
      console.log("\n" + s.prompt + "\n");
      const tools = db.toolEvents(t.id);
      if (tools.length) console.log(c.dim(tools.map((e) => `  ${e.tool}${e.file ? " " + e.file : ""}`).join("\n")) + "\n");
      if (t.diff) printDiff(t.diff);
      else console.log(c.dim(t.ended_at ? "(no file changes)" : "(turn still in progress)"));
    }
    db.close();
  });

program
  .command("commit <sha>")
  .description("Show the prompts behind a commit")
  .option("--json", "machine-readable output")
  .action((sha: string, o) => {
    const db = openDb();
    const r = traceCommit(db, sha);
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else {
      if (r.commit) console.log(`${c.bold(r.commit.sha.slice(0, 8))} ${r.commit.subject} ${c.dim(r.commit.author)}\n`);
      if (!r.turns.length) console.log("no recorded prompts for this commit");
      for (const t of r.turns) {
        printTurnHeader(t);
        console.log("  " + oneLine(t.prompt, 120) + "\n");
      }
    }
    db.close();
  });

program
  .command("search <query...>")
  .description("Full-text search over everyone's prompts")
  .action((words: string[]) => {
    const db = openDb();
    importNotes(db);
    for (const t of db.searchPrompts(words.join(" "))) {
      printTurnHeader(summarize(db, t));
      console.log("  " + oneLine(t.origin === "local" ? t.prompt : t.prompt_redacted, 120) + "\n");
    }
    db.close();
  });

const notes = program.command("notes").description("Share prompts with your team via git notes");
notes
  .command("push")
  .option("-r, --remote <remote>", "remote", "origin")
  .description("Push your commit-linked prompts (redacted) to the remote")
  .action((o) => {
    const db = openDb();
    pushNotes(db, o.remote);
    db.close();
    console.log(`pushed refs/notes/prompttrace to ${o.remote}`);
  });
notes
  .command("fetch")
  .option("-r, --remote <remote>", "remote", "origin")
  .description("Fetch teammates' prompts and import them")
  .action((o) => {
    const db = openDb();
    const r = fetchNotes(db, o.remote);
    db.close();
    console.log(`imported ${r.turns} new turn(s) from ${r.notes} commit note(s)`);
  });
notes
  .command("import")
  .description("Import notes already present locally into the DB")
  .action(() => {
    const db = openDb();
    const r = importNotes(db);
    db.close();
    console.log(`imported ${r.turns} new turn(s) from ${r.notes} commit note(s)`);
  });

program
  .command("export")
  .description("Write a self-contained HTML page for browsing everyone's prompts (prompts and diffs redacted)")
  .requiredOption("--html <file>", "output path")
  .option("-n, --limit <n>", "max turns", "2000")
  .action((o) => {
    const db = openDb();
    writeFileSync(o.html, exportHtml(db, { limit: Number(o.limit), repoName: basename(db.root) }));
    db.close();
    console.log(`wrote ${o.html}`);
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio")
  .option("--repo <path>", "default repo (defaults to cwd)")
  .action(async (o) => {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer(o.repo ?? process.cwd());
  });

program.parseAsync(process.argv);
