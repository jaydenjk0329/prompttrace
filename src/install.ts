import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTES_REF, gitPath, tryGit } from "./git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const MARK = "# prompttrace";

/** How hooks invoke us: global `prompttrace` if on PATH, else this exact install. */
export function resolveInvocation(override?: string): string[] {
  if (override) return override.split(" ");
  try {
    const p = execFileSync("sh", ["-c", "command -v prompttrace"], { encoding: "utf8" }).trim();
    if (p) return ["prompttrace"];
  } catch {
    /* not on PATH */
  }
  // Prefer plain `node` from PATH over process.execPath: version-manager and
  // Homebrew Cellar paths break as soon as node is upgraded.
  let node = process.execPath;
  try {
    const p = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    if (p) node = "node";
  } catch {
    /* fall back to execPath */
  }
  return [node, join(PKG_ROOT, "dist", "cli.js")];
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const shell = (argv: string[]) => argv.map(q).join(" ");

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  const txt = readFileSync(path, "utf8").trim();
  return txt ? JSON.parse(txt) : {};
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

const isOurs = (cmd: unknown) => typeof cmd === "string" && / hook (prompt|tool|stop) --agent /.test(cmd) && /prompttrace|cli\.js/.test(cmd);

function stripOurHooks(settings: any): void {
  if (!settings.hooks) return;
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = (settings.hooks[ev] as any[])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

/** Same hooks.json shape works for Claude Code settings and Codex hooks.json. */
function addHooks(settings: any, inv: string[], agent: "claude" | "codex"): void {
  stripOurHooks(settings);
  settings.hooks ??= {};
  const cmd = (ev: string) => ({ type: "command", command: `${shell(inv)} hook ${ev} --agent ${agent}`, timeout: 30 });
  const add = (event: string, group: any) => (settings.hooks[event] ??= []).push(group);
  add("UserPromptSubmit", { hooks: [cmd("prompt")] });
  add("PostToolUse", {
    matcher: agent === "claude" ? "Edit|Write|MultiEdit|NotebookEdit|Bash" : ".*",
    hooks: [cmd("tool")],
  });
  add("Stop", { hooks: [cmd("stop")] });
  if (agent === "codex") add("Interrupt", { hooks: [{ ...cmd("stop"), timeout: 3 }] });
}

export interface InstallOptions {
  root: string;
  claude?: boolean;
  codex?: boolean;
  gitHooks?: boolean;
  local?: boolean; // Claude: write settings.local.json instead of the shared settings.json
  command?: string;
}

export function install(o: InstallOptions): string[] {
  const log: string[] = [];
  const inv = resolveInvocation(o.command);
  const mcpEntry = { command: inv[0], args: [...inv.slice(1), "mcp"] };

  if (o.claude) {
    const settingsPath = join(o.root, ".claude", o.local ? "settings.local.json" : "settings.json");
    const s = readJson(settingsPath);
    addHooks(s, inv, "claude");
    writeJson(settingsPath, s);
    log.push(`Claude Code hooks → ${settingsPath}`);

    const mcpPath = join(o.root, ".mcp.json");
    const m = readJson(mcpPath);
    m.mcpServers ??= {};
    m.mcpServers.prompttrace = mcpEntry;
    writeJson(mcpPath, m);
    log.push(`MCP server → ${mcpPath}`);

    const skillDst = join(o.root, ".claude", "skills", "prompt-trace", "SKILL.md");
    mkdirSync(dirname(skillDst), { recursive: true });
    copyFileSync(join(PKG_ROOT, "skill", "prompt-trace", "SKILL.md"), skillDst);
    log.push(`Skill → ${skillDst}`);
  }

  if (o.codex) {
    const hooksPath = join(o.root, ".codex", "hooks.json");
    const h = readJson(hooksPath);
    addHooks(h, inv, "codex");
    writeJson(hooksPath, h);
    log.push(`Codex hooks → ${hooksPath}  (run /hooks in Codex once to trust them)`);

    const cfgPath = join(o.root, ".codex", "config.toml");
    const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
    if (!/^\[mcp_servers\.prompttrace\]/m.test(cfg)) {
      const block =
        `\n${MARK}\n[mcp_servers.prompttrace]\ncommand = ${JSON.stringify(mcpEntry.command)}\n` +
        `args = ${JSON.stringify(mcpEntry.args)}\n`;
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, cfg + block);
      log.push(`Codex MCP server → ${cfgPath}`);
    }

    const agentsPath = join(o.root, "AGENTS.md");
    const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    if (!agents.includes("<!-- prompttrace -->")) {
      const snippet = readFileSync(join(PKG_ROOT, "skill", "AGENTS.snippet.md"), "utf8");
      writeFileSync(agentsPath, agents + (agents && !agents.endsWith("\n") ? "\n" : "") + (agents ? "\n" : "") + snippet);
      log.push(`Usage instructions → ${agentsPath}`);
    }
  }

  if (o.gitHooks) {
    const hook = join(gitPath(o.root, "hooks"), "post-commit");
    const line = `${shell(inv)} link-commit >/dev/null 2>&1 || true ${MARK}`;
    let body = existsSync(hook) ? readFileSync(hook, "utf8") : "#!/bin/sh\n";
    body = body.split("\n").filter((l) => !l.includes(MARK)).join("\n");
    if (!body.endsWith("\n")) body += "\n";
    writeFileSync(hook, body + line + "\n");
    chmodSync(hook, 0o755);
    log.push(`git post-commit hook → ${hook}`);

    // Carry notes across `commit --amend` and `rebase`.
    const refs = (tryGit(o.root, ["config", "--get-all", "notes.rewriteRef"]) ?? "").split("\n");
    if (!refs.includes(NOTES_REF)) tryGit(o.root, ["config", "--add", "notes.rewriteRef", NOTES_REF]);
    log.push(`git config notes.rewriteRef ${NOTES_REF}`);
  }
  return log;
}

export function uninstall(root: string): string[] {
  const log: string[] = [];
  for (const p of [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json"), join(root, ".codex", "hooks.json")]) {
    if (!existsSync(p)) continue;
    const s = readJson(p);
    stripOurHooks(s);
    writeJson(p, s);
    log.push(`removed hooks from ${p}`);
  }
  const mcpPath = join(root, ".mcp.json");
  if (existsSync(mcpPath)) {
    const m = readJson(mcpPath);
    if (m.mcpServers?.prompttrace) {
      delete m.mcpServers.prompttrace;
      writeJson(mcpPath, m);
      log.push(`removed MCP server from ${mcpPath}`);
    }
  }
  const skill = join(root, ".claude", "skills", "prompt-trace");
  if (existsSync(skill)) {
    rmSync(skill, { recursive: true, force: true });
    log.push(`removed ${skill}`);
  }
  const hook = join(gitPath(root, "hooks"), "post-commit");
  if (existsSync(hook)) {
    const body = readFileSync(hook, "utf8");
    if (body.includes(MARK)) {
      writeFileSync(hook, body.split("\n").filter((l) => !l.includes(MARK)).join("\n"));
      log.push(`removed prompttrace line from ${hook}`);
    }
  }
  log.push("left in place: .prompttrace/ data, git notes, .codex/config.toml MCP block, AGENTS.md section (remove manually if wanted)");
  return log;
}
