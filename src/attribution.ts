import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TraceDB, type Turn } from "./db.js";
import { blameLine, commitInfo, filterDiff, isTrivialLine, isZeroSha, lineHash, tryGit } from "./git.js";
import { importCommitNote } from "./notes.js";

export type Confidence =
  | "line" // the line's exact content was added by this turn, in the commit git blame points to
  | "in-progress" // added by a turn that is still running
  | "uncommitted" // uncommitted line whose content matches a line this turn added
  | "commit" // turn is part of the blamed commit and touched the file, but the line itself didn't match
  | "none";

export interface TurnSummary {
  id: string;
  agent: string;
  author: string;
  prompt: string;
  started_at: string;
  ended_at: string | null;
  session_id: string;
  origin: string;
  commits: string[];
}

export interface LineTrace {
  file: string;
  line: number;
  content: string;
  confidence: Confidence;
  commit: { sha: string; subject: string; author: string; date: string } | null;
  turn: TurnSummary | null;
  /** Other plausible turns (e.g. earlier turns that added identical content). */
  alternatives: TurnSummary[];
  /** For generic lines like "}" or blank lines: the nearby line whose attribution was borrowed. */
  via_line?: number;
  diff?: string;
}

export function summarize(db: TraceDB, t: Turn): TurnSummary {
  return {
    id: t.id,
    agent: t.agent,
    author: t.author_email ? `${t.author_name} <${t.author_email}>` : t.author_name,
    // Your own turns show the raw prompt; teammates' arrive already redacted.
    prompt: t.origin === "local" ? t.prompt : t.prompt_redacted,
    started_at: t.started_at,
    ended_at: t.ended_at,
    session_id: t.session_id,
    origin: t.origin,
    commits: db.commitsForTurn(t.id),
  };
}

function readLines(root: string, file: string): string[] | null {
  try {
    return readFileSync(join(root, file), "utf8").split("\n");
  } catch {
    return null;
  }
}

function readLine(root: string, file: string, line: number): string | null {
  const lines = readLines(root, file);
  return lines && line >= 1 && line <= lines.length ? lines[line - 1] : null;
}

function fileInTree(root: string, tree: string, file: string): string | null {
  return tryGit(root, ["show", `${tree}:${file}`]);
}

function turnsForCommit(db: TraceDB, sha: string): Turn[] {
  let turns = db.turnsForCommit(sha);
  if (turns.length === 0) {
    importCommitNote(db, sha); // teammate's commit: pull its note into the DB (also links it)
    turns = db.turnsForCommit(sha);
  }
  return turns;
}

function addedHashes(db: TraceDB, turnId: string, file?: string): Set<string> {
  const rows = (
    file
      ? db.db.prepare("SELECT hash FROM line_hashes WHERE turn_id = ? AND file = ?").all(turnId, file)
      : db.db.prepare("SELECT hash FROM line_hashes WHERE turn_id = ?").all(turnId)
  ) as Array<{ hash: string }>;
  return new Set(rows.map((r) => r.hash));
}

function hunkCovers(db: TraceDB, turnId: string, file: string, line: number): boolean {
  return !!db.db
    .prepare("SELECT 1 FROM hunks WHERE turn_id = ? AND file = ? AND ? BETWEEN new_start AND new_start + new_len - 1 LIMIT 1")
    .get(turnId, file, line);
}

/**
 * Generic lines ("}", blank) can't be matched by content, so borrow the
 * attribution of the nearest meaningful line: closers look upward to the code
 * they close, blank lines look downward. Only borrowed when git blame agrees
 * both lines came from the same commit (or both are uncommitted).
 */
export function traceLine(db: TraceDB, file: string, line: number, withDiff = true): LineTrace {
  const direct = traceLineDirect(db, file, line, withDiff);
  const lines = readLines(db.root, file);
  if (!lines || line < 1 || line > lines.length || !isTrivialLine(lines[line - 1])) return direct;
  const up = lines[line - 1].trim() !== "";
  const order = up ? [-1, 1] : [1, -1];
  const blameSha = blameLine(db.root, file, line)?.sha;
  for (const dir of order) {
    for (let n = line + dir, steps = 0; n >= 1 && n <= lines.length && steps < 8; n += dir, steps++) {
      if (isTrivialLine(lines[n - 1])) continue;
      if (blameLine(db.root, file, n)?.sha !== blameSha) break;
      const near = traceLineDirect(db, file, n, withDiff);
      if (near.turn && near.confidence !== "commit" && near.confidence !== "none") {
        return { ...near, line, content: lines[line - 1], commit: direct.commit ?? near.commit, via_line: n };
      }
      break;
    }
  }
  return direct;
}

function traceLineDirect(db: TraceDB, file: string, line: number, withDiff: boolean): LineTrace {
  const content = readLine(db.root, file, line);
  const base: LineTrace = { file, line, content: content ?? "", confidence: "none", commit: null, turn: null, alternatives: [] };
  if (content === null) return base;
  const hash = lineHash(content);
  const trivial = isTrivialLine(content);
  const finish = (t: Turn, confidence: Confidence, alts: Turn[] = []): LineTrace => ({
    ...base,
    confidence,
    turn: summarize(db, t),
    alternatives: alts.filter((a) => a.id !== t.id).slice(0, 5).map((a) => summarize(db, a)),
    diff: withDiff ? filterDiff(t.diff ?? "", new Set([file])) : undefined,
  });

  const blame = blameLine(db.root, file, line);

  if (blame && !isZeroSha(blame.sha)) {
    // Committed line: trust git blame for *which commit*, then find the turn in it.
    base.commit = commitInfo(db.root, blame.sha);
    const turns = turnsForCommit(db, blame.sha);
    if (!trivial) {
      const hits = turns.filter((t) => addedHashes(db, t.id, blame.origFile).has(hash) || addedHashes(db, t.id, file).has(hash));
      const anyFile = hits.length ? hits : turns.filter((t) => addedHashes(db, t.id).has(hash)); // moved/copied code
      if (anyFile.length) return finish(anyFile[anyFile.length - 1], "line", anyFile.slice(0, -1).reverse());
    }
    const touching = turns.filter((t) => db.filesForTurn(t.id).some((f) => f === file || f === blame.origFile));
    if (touching.length) return finish(touching[touching.length - 1], "commit", touching.slice(0, -1).reverse());
    return base; // human-written commit, or one made before prompttrace was installed
  }

  // Uncommitted line. First: is a turn running right now that added it?
  // Ignore turns left open by a crashed session long ago.
  const recent = new Date(Date.now() - 6 * 3600_000).toISOString();
  const open = db.db
    .prepare("SELECT * FROM turns WHERE ended_at IS NULL AND origin = 'local' AND started_at > ? ORDER BY started_at DESC")
    .all(recent) as unknown as Turn[];
  for (const t of open) {
    const before = t.before_tree ? fileInTree(db.root, t.before_tree, file) : null;
    const beforeHas = before !== null && before.split("\n").some((l) => l.trim() === content.trim());
    if (!beforeHas && !trivial) return finish(t, "in-progress");
  }

  if (!trivial) {
    const hits = db.turnsWithLine(hash, file).filter((t) => t.ended_at);
    // A finished turn's after-state must still contain the line (guards against stale hashes).
    const verified = hits.filter((t) => {
      if (!t.after_tree) return true;
      const after = fileInTree(db.root, t.after_tree, file);
      return after === null || after.split("\n").some((l) => lineHash(l) === hash);
    });
    if (verified.length) return finish(verified[0], "uncommitted", verified.slice(1));
  }
  // Trivial line ("}", blank, ...): fall back to the newest turn whose hunk covers this position.
  const covering = db.turnsForFile(file).reverse().filter((t) => t.ended_at && hunkCovers(db, t.id, file, line));
  if (covering.length) return finish(covering[0], "uncommitted", covering.slice(1));
  return base;
}

export function traceRange(db: TraceDB, file: string, start: number, end: number): { lines: LineTrace[]; turns: TurnSummary[] } {
  const lines: LineTrace[] = [];
  const turns = new Map<string, TurnSummary>();
  for (let n = start; n <= end; n++) {
    const t = traceLine(db, file, n, false);
    lines.push(t);
    if (t.turn) turns.set(t.turn.id, t.turn);
  }
  return { lines, turns: [...turns.values()] };
}

/** Every turn that touched a file, oldest first (imports teammates' notes for its commits lazily). */
export function traceFile(db: TraceDB, file: string, limitCommits = 200): TurnSummary[] {
  const log = tryGit(db.root, ["log", "--follow", `-n${limitCommits}`, "--format=%H", "--", file]) ?? "";
  for (const sha of log.split("\n").filter(Boolean)) if (db.turnsForCommit(sha).length === 0) importCommitNote(db, sha);
  return db.turnsForFile(file).map((t) => summarize(db, t));
}

export function traceCommit(db: TraceDB, sha: string): { commit: ReturnType<typeof commitInfo>; turns: Array<TurnSummary & { diff: string }> } {
  const full = tryGit(db.root, ["rev-parse", sha])?.trim() ?? sha;
  return {
    commit: commitInfo(db.root, full),
    turns: turnsForCommit(db, full).map((t) => ({ ...summarize(db, t), diff: t.diff ?? "" })),
  };
}
