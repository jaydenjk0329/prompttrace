import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
// node:sqlite is built into Node >= 22.13; no native build step for users.
import { DatabaseSync } from "node:sqlite";
import { gitPath, isTrivialLine, lineHash, parseDiff } from "./git.js";

export interface Turn {
  id: string;
  session_id: string;
  agent: string;
  author_name: string;
  author_email: string;
  prompt: string;
  prompt_redacted: string;
  before_tree: string | null;
  after_tree: string | null;
  before_source: string | null;
  diff: string | null;
  started_at: string;
  ended_at: string | null;
  origin: "local" | "imported";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  prompt_redacted TEXT NOT NULL,
  before_tree TEXT,
  after_tree TEXT,
  before_source TEXT,
  diff TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  origin TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, started_at);
CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at);
CREATE TABLE IF NOT EXISTS tool_events (
  turn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  file TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_events_turn ON tool_events(turn_id);
CREATE TABLE IF NOT EXISTS hunks (
  turn_id TEXT NOT NULL,
  file TEXT NOT NULL,
  new_start INTEGER NOT NULL,
  new_len INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hunks_file ON hunks(file);
CREATE INDEX IF NOT EXISTS hunks_turn ON hunks(turn_id);
CREATE TABLE IF NOT EXISTS line_hashes (
  turn_id TEXT NOT NULL,
  file TEXT NOT NULL,
  hash TEXT NOT NULL,
  trivial INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS line_hashes_lookup ON line_hashes(file, hash);
CREATE INDEX IF NOT EXISTS line_hashes_hash ON line_hashes(hash);
CREATE TABLE IF NOT EXISTS turn_commits (
  turn_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (turn_id, sha)
);
CREATE INDEX IF NOT EXISTS turn_commits_sha ON turn_commits(sha);
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(turn_id UNINDEXED, prompt);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function dataDir(root: string): string {
  return join(root, ".prompttrace");
}

/** Make sure .prompttrace/ never gets committed by accident. */
function ensureExcluded(root: string): void {
  try {
    const exclude = gitPath(root, "info/exclude");
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split("\n").some((l) => l.trim() === ".prompttrace/")) {
      mkdirSync(join(exclude, ".."), { recursive: true });
      appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}.prompttrace/\n`);
    }
  } catch {
    /* non-fatal */
  }
}

export class TraceDB {
  readonly db: DatabaseSync;

  constructor(readonly root: string) {
    const dir = dataDir(root);
    mkdirSync(dir, { recursive: true });
    ensureExcluded(root);
    this.db = new DatabaseSync(join(dir, "trace.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  insertTurn(t: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns(id, session_id, agent, author_name, author_email, prompt, prompt_redacted,
          before_tree, after_tree, before_source, diff, started_at, ended_at, origin)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id, t.session_id, t.agent, t.author_name, t.author_email, t.prompt, t.prompt_redacted,
        t.before_tree, t.after_tree, t.before_source, t.diff, t.started_at, t.ended_at, t.origin,
      );
    this.db.prepare("INSERT INTO prompts_fts(turn_id, prompt) VALUES(?, ?)").run(t.id, t.prompt);
  }

  getTurn(id: string): Turn | null {
    // Allow short-id prefixes like git does.
    const rows = this.db.prepare("SELECT * FROM turns WHERE id = ? OR id LIKE ? LIMIT 2").all(id, `${id}%`) as unknown as Turn[];
    if (rows.length === 0) return null;
    return rows.find((r) => r.id === id) ?? (rows.length === 1 ? rows[0] : null);
  }

  openTurn(sessionId: string): Turn | null {
    return (
      (this.db
        .prepare("SELECT * FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
        .get(sessionId) as unknown as Turn | undefined) ?? null
    );
  }

  lastTurnInSession(sessionId: string): Turn | null {
    return (
      (this.db
        .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(sessionId) as unknown as Turn | undefined) ?? null
    );
  }

  /** Close a turn: store its after-tree + diff and index hunks/line hashes. */
  finishTurn(id: string, afterTree: string, diff: string, endedAt: string): void {
    this.tx(() => {
      this.db.prepare("UPDATE turns SET after_tree = ?, diff = ?, ended_at = ? WHERE id = ?").run(afterTree, diff, endedAt, id);
      this.indexDiff(id, diff);
    });
  }

  indexDiff(turnId: string, diff: string): void {
    this.db.prepare("DELETE FROM hunks WHERE turn_id = ?").run(turnId);
    this.db.prepare("DELETE FROM line_hashes WHERE turn_id = ?").run(turnId);
    const insH = this.db.prepare("INSERT INTO hunks(turn_id, file, new_start, new_len) VALUES(?,?,?,?)");
    const insL = this.db.prepare("INSERT INTO line_hashes(turn_id, file, hash, trivial) VALUES(?,?,?,?)");
    for (const h of parseDiff(diff)) {
      insH.run(turnId, h.file, h.newStart, h.newLen);
      for (const line of h.added) insL.run(turnId, h.file, lineHash(line), isTrivialLine(line) ? 1 : 0);
    }
  }

  recordTool(turnId: string, tool: string, file: string | null, ts: string): void {
    this.db.prepare("INSERT INTO tool_events(turn_id, tool, file, ts) VALUES(?,?,?,?)").run(turnId, tool, file, ts);
  }

  toolEvents(turnId: string): Array<{ tool: string; file: string | null; ts: string }> {
    return this.db.prepare("SELECT tool, file, ts FROM tool_events WHERE turn_id = ? ORDER BY ts").all(turnId) as never;
  }

  filesForTurn(turnId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT file FROM hunks WHERE turn_id = ?").all(turnId) as Array<{ file: string }>).map((r) => r.file);
  }

  /** Turns that added a line with this content hash, newest first. */
  turnsWithLine(hash: string, file: string | null): Turn[] {
    const sql = file
      ? `SELECT DISTINCT t.* FROM line_hashes l JOIN turns t ON t.id = l.turn_id WHERE l.hash = ? AND l.file = ? ORDER BY t.started_at DESC`
      : `SELECT DISTINCT t.* FROM line_hashes l JOIN turns t ON t.id = l.turn_id WHERE l.hash = ? ORDER BY t.started_at DESC`;
    return (file ? this.db.prepare(sql).all(hash, file) : this.db.prepare(sql).all(hash)) as unknown as Turn[];
  }

  turnsForFile(file: string): Turn[] {
    return this.db
      .prepare(`SELECT DISTINCT t.* FROM hunks h JOIN turns t ON t.id = h.turn_id WHERE h.file = ? ORDER BY t.started_at ASC`)
      .all(file) as unknown as Turn[];
  }

  linkCommit(turnId: string, sha: string): void {
    this.db.prepare("INSERT OR IGNORE INTO turn_commits(turn_id, sha) VALUES(?, ?)").run(turnId, sha);
  }

  turnsForCommit(sha: string): Turn[] {
    return this.db
      .prepare(`SELECT t.* FROM turn_commits c JOIN turns t ON t.id = c.turn_id WHERE c.sha = ? ORDER BY t.started_at ASC`)
      .all(sha) as unknown as Turn[];
  }

  commitsForTurn(turnId: string): string[] {
    return (this.db.prepare("SELECT sha FROM turn_commits WHERE turn_id = ?").all(turnId) as Array<{ sha: string }>).map((r) => r.sha);
  }

  /** Non-trivial added-line hashes for a turn in one file. */
  lineHashesFor(turnId: string, file: string): string[] {
    return (
      this.db.prepare("SELECT hash FROM line_hashes WHERE turn_id = ? AND file = ? AND trivial = 0").all(turnId, file) as Array<{ hash: string }>
    ).map((r) => r.hash);
  }

  /** Local, finished turns not yet fully linked to commits. */
  candidateTurnsForCommit(): Turn[] {
    return this.db
      .prepare(`SELECT * FROM turns WHERE origin = 'local' AND ended_at IS NOT NULL ORDER BY started_at ASC`)
      .all() as unknown as Turn[];
  }

  listTurns(opts: { author?: string; session?: string; since?: string; file?: string; agent?: string; limit?: number } = {}): Turn[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.author) {
      where.push("(t.author_name LIKE ? OR t.author_email LIKE ?)");
      args.push(`%${opts.author}%`, `%${opts.author}%`);
    }
    if (opts.session) {
      where.push("t.session_id = ?");
      args.push(opts.session);
    }
    if (opts.agent) {
      where.push("t.agent = ?");
      args.push(opts.agent);
    }
    if (opts.since) {
      where.push("t.started_at >= ?");
      args.push(opts.since);
    }
    if (opts.file) {
      where.push("EXISTS (SELECT 1 FROM hunks h WHERE h.turn_id = t.id AND h.file = ?)");
      args.push(opts.file);
    }
    const sql = `SELECT t.* FROM turns t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.started_at DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    return this.db.prepare(sql).all(...args) as unknown as Turn[];
  }

  searchPrompts(query: string, limit = 20): Turn[] {
    // Quote each term so user input can't break FTS syntax.
    const q = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(" ");
    if (!q) return [];
    return this.db
      .prepare(
        `SELECT t.* FROM prompts_fts f JOIN turns t ON t.id = f.turn_id WHERE prompts_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, limit) as unknown as Turn[];
  }

  authors(): Array<{ author_name: string; author_email: string; turns: number }> {
    return this.db
      .prepare("SELECT author_name, author_email, COUNT(*) AS turns FROM turns GROUP BY author_name, author_email ORDER BY turns DESC")
      .all() as never;
  }

  /** Upsert a turn received from a teammate's git note. Never overwrites local turns. */
  importTurn(t: Turn, sha: string): boolean {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT origin FROM turns WHERE id = ?").get(t.id) as { origin: string } | undefined;
      let inserted = false;
      if (!existing) {
        this.insertTurn({ ...t, origin: "imported" });
        if (t.diff) this.indexDiff(t.id, t.diff);
        inserted = true;
      } else if (existing.origin === "imported" && t.diff) {
        // A turn split over several commits arrives as several partial diffs: merge them.
        const cur = this.getTurn(t.id)!;
        if (!cur.diff?.includes(t.diff)) {
          const merged = (cur.diff ?? "") + t.diff;
          this.db.prepare("UPDATE turns SET diff = ? WHERE id = ?").run(merged, t.id);
          this.indexDiff(t.id, merged);
        }
      }
      this.linkCommit(t.id, sha);
      return inserted;
    });
  }
}
