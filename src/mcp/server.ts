import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { traceCommit, traceFile, traceLine, traceRange, summarize } from "../attribution.js";
import { endTurn, recordCompletedTurn, startTurn } from "../capture/turns.js";
import { TraceDB } from "../db.js";
import { repoRelative, repoRoot } from "../git.js";
import { importNotes } from "../notes.js";
import { truncate } from "../redact.js";

const MAX_OUT = 60_000;

export async function startMcpServer(defaultCwd = process.cwd()): Promise<void> {
  const server = new McpServer({ name: "prompttrace", version: "0.1.0" });

  const withDb = <T>(repo: string | undefined, fn: (db: TraceDB, root: string, cwd: string) => T) => {
    const cwd = repo ?? defaultCwd;
    const root = repoRoot(cwd);
    if (!root) throw new Error(`Not inside a git repository: ${cwd}`);
    const db = new TraceDB(root);
    try {
      return fn(db, root, cwd);
    } finally {
      db.close();
    }
  };
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: truncate(JSON.stringify(data, null, 2), MAX_OUT) }] });
  const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
  const run = <T>(fn: () => T) => {
    try {
      return ok(fn());
    } catch (e) {
      return fail(e);
    }
  };
  const repo = z.string().optional().describe("Path inside the target git repo (defaults to the server's working directory)");
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "trace_line",
    {
      description:
        "Find which agent prompt produced a specific line of code. Returns the prompt, who wrote it, which agent, when, the commit, a confidence level, and that turn's diff for the file.",
      inputSchema: { file: z.string().describe("File path (absolute or repo-relative)"), line: z.number().int().min(1), repo },
      annotations: readOnly,
    },
    ({ file, line, repo: r }) => run(() => withDb(r, (db, root, cwd) => traceLine(db, repoRelative(root, cwd, file), line))),
  );

  server.registerTool(
    "trace_range",
    {
      description: "Find the prompts responsible for a range of lines. Returns per-line attribution plus the distinct prompts involved.",
      inputSchema: { file: z.string(), start: z.number().int().min(1), end: z.number().int().min(1), repo },
      annotations: readOnly,
    },
    ({ file, start, end, repo: r }) =>
      run(() => withDb(r, (db, root, cwd) => traceRange(db, repoRelative(root, cwd, file), start, Math.min(end, start + 500)))),
  );

  server.registerTool(
    "trace_file",
    {
      description: "List every prompt (from anyone on the team) that changed a file, oldest first.",
      inputSchema: { file: z.string(), repo },
      annotations: readOnly,
    },
    ({ file, repo: r }) => run(() => withDb(r, (db, root, cwd) => traceFile(db, repoRelative(root, cwd, file)))),
  );

  server.registerTool(
    "trace_commit",
    {
      description: "Show the prompts behind a git commit, with each turn's diff.",
      inputSchema: { sha: z.string().describe("Commit sha or ref, e.g. HEAD~2"), repo },
      annotations: readOnly,
    },
    ({ sha, repo: r }) => run(() => withDb(r, (db) => traceCommit(db, sha))),
  );

  server.registerTool(
    "list_turns",
    {
      description:
        "Browse recorded prompts (turns), newest first. Filter by teammate (name or email substring), agent, file, session, or ISO start time.",
      inputSchema: {
        author: z.string().optional(),
        agent: z.string().optional().describe("claude | codex | mcp"),
        file: z.string().optional(),
        session: z.string().optional(),
        since: z.string().optional().describe("ISO timestamp"),
        limit: z.number().int().min(1).max(500).optional(),
        repo,
      },
      annotations: readOnly,
    },
    ({ repo: r, file, ...rest }) =>
      run(() =>
        withDb(r, (db, root, cwd) => {
          importNotes(db);
          return db.listTurns({ ...rest, file: file ? repoRelative(root, cwd, file) : undefined }).map((t) => ({
            ...summarize(db, t),
            files: db.filesForTurn(t.id),
          }));
        }),
      ),
  );

  server.registerTool(
    "get_turn",
    {
      description: "Get one turn by id (a unique prefix works): full prompt, tools the agent used, files, commits, and the complete diff.",
      inputSchema: { id: z.string(), repo },
      annotations: readOnly,
    },
    ({ id, repo: r }) =>
      run(() =>
        withDb(r, (db) => {
          const t = db.getTurn(id);
          if (!t) throw new Error(`No turn matching ${id}`);
          return { ...summarize(db, t), files: db.filesForTurn(t.id), tools: db.toolEvents(t.id), diff: t.diff ?? "" };
        }),
      ),
  );

  server.registerTool(
    "search_prompts",
    {
      description: "Full-text search over recorded prompts from everyone on the team.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional(), repo },
      annotations: readOnly,
    },
    ({ query, limit, repo: r }) =>
      run(() =>
        withDb(r, (db) => {
          importNotes(db);
          return db.searchPrompts(query, limit).map((t) => ({ ...summarize(db, t), files: db.filesForTurn(t.id) }));
        }),
      ),
  );

  server.registerTool(
    "list_authors",
    { description: "Who has recorded prompts in this repo, with turn counts.", inputSchema: { repo }, annotations: readOnly },
    ({ repo: r }) =>
      run(() =>
        withDb(r, (db) => {
          importNotes(db);
          return db.authors();
        }),
      ),
  );

  // Fallback capture for MCP clients without hook support.
  server.registerTool(
    "begin_turn",
    {
      description:
        "ONLY if this agent has no prompttrace hooks installed: call at the start of handling a user request, with the user's prompt verbatim. Snapshots the working tree.",
      inputSchema: { prompt: z.string(), session: z.string().optional(), repo },
    },
    ({ prompt, session, repo: r }) =>
      run(() => withDb(r, (db) => ({ turn_id: startTurn(db, { sessionId: `mcp:${session ?? "default"}`, agent: "mcp", prompt }).id }))),
  );

  server.registerTool(
    "end_turn",
    {
      description:
        "ONLY if this agent has no prompttrace hooks installed: call after finishing a user request. Records the diff since begin_turn. If begin_turn was never called, pass `prompt` to record the turn against the last known snapshot.",
      inputSchema: { session: z.string().optional(), prompt: z.string().optional(), repo },
    },
    ({ session, prompt, repo: r }) =>
      run(() =>
        withDb(r, (db) => {
          const sid = `mcp:${session ?? "default"}`;
          const t = endTurn(db, sid) ?? (prompt ? recordCompletedTurn(db, { sessionId: sid, agent: "mcp", prompt }) : null);
          if (!t) throw new Error("No open turn; call begin_turn first or pass prompt.");
          return { turn_id: t.id, files: db.filesForTurn(t.id) };
        }),
      ),
  );

  await server.connect(new StdioServerTransport());
}
