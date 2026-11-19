import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TraceDB, dataDir } from "../db.js";
import { repoRelative, repoRoot } from "../git.js";
import { endTurn, recordTool, startTurn } from "./turns.js";

/**
 * Claude Code and Codex share the same hook model: JSON on stdin with
 * session_id / cwd, plus `prompt` on UserPromptSubmit and tool_name /
 * tool_input on PostToolUse. One adapter handles both.
 */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  turn_id?: string;
}

export type HookEvent = "prompt" | "tool" | "stop";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function toolTarget(root: string, cwd: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v) return repoRelative(root, cwd, v);
  }
  return null;
}

function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const cmd = input?.command;
  if (typeof cmd === "string") return `${name}: ${cmd.replace(/\s+/g, " ").slice(0, 200)}`;
  return name;
}

/**
 * Entry point for `prompttrace hook <event> --agent <agent>`.
 * Must never break the agent: swallow every error, print nothing to stdout
 * (both agents inject UserPromptSubmit stdout into the model's context), exit 0.
 */
export function runHook(event: HookEvent, agent: string, raw = readStdin()): void {
  let root: string | null = null;
  try {
    const p: HookPayload = raw.trim() ? JSON.parse(raw) : {};
    const cwd = p.cwd || process.cwd();
    root = repoRoot(cwd);
    if (!root) return; // not a git repo: nothing to trace
    if (process.env.PROMPTTRACE_DISABLE === "1") return;
    const session = `${agent}:${p.session_id ?? "default"}`;
    const db = new TraceDB(root);
    try {
      if (event === "prompt") {
        if (typeof p.prompt === "string") startTurn(db, { sessionId: session, agent, prompt: p.prompt });
      } else if (event === "tool") {
        const name = p.tool_name ?? "unknown";
        recordTool(db, session, toolLabel(name, p.tool_input), toolTarget(root, cwd, p.tool_input));
      } else if (event === "stop") {
        endTurn(db, session);
      }
    } finally {
      db.close();
    }
  } catch (e) {
    logError(root, event, e);
  }
}

function logError(root: string | null, event: string, e: unknown): void {
  try {
    const dir = root ? dataDir(root) : null;
    const msg = `${new Date().toISOString()} hook ${event}: ${e instanceof Error ? e.stack : String(e)}\n`;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "hook.log"), msg);
    } else {
      process.stderr.write(msg);
    }
  } catch {
    /* give up silently */
  }
}
