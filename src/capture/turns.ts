import { randomUUID } from "node:crypto";
import { TraceDB, type Turn } from "../db.js";
import { author, diffTrees, emptyTree, headTree, pinTree, snapshot } from "../git.js";
import { redact } from "../redact.js";

const LAST_SNAPSHOT = "last_snapshot";

const now = () => new Date().toISOString();

/**
 * Begin a turn: snapshot the working tree as the "before" state.
 * If the session still has an open turn (e.g. the user interrupted the agent
 * and Stop never fired), close it first using the same snapshot.
 */
export function startTurn(db: TraceDB, opts: { sessionId: string; agent: string; prompt: string }): Turn {
  const tree = snapshot(db.root);
  const open = db.openTurn(opts.sessionId);
  if (open) closeWithTree(db, open, tree);

  const a = author(db.root);
  const turn: Turn = {
    id: randomUUID(),
    session_id: opts.sessionId,
    agent: opts.agent,
    author_name: a.name,
    author_email: a.email,
    prompt: opts.prompt,
    prompt_redacted: redact(opts.prompt),
    before_tree: tree,
    after_tree: null,
    before_source: "snapshot",
    diff: null,
    started_at: now(),
    ended_at: null,
    origin: "local",
  };
  db.insertTurn(turn);
  pinTree(db.root, turn.id, "before", tree);
  db.setMeta(LAST_SNAPSHOT, tree);
  return turn;
}

/** End the session's open turn: snapshot "after" and record the diff. */
export function endTurn(db: TraceDB, sessionId: string): Turn | null {
  const open = db.openTurn(sessionId);
  if (!open) return null;
  return closeWithTree(db, open, snapshot(db.root));
}

function closeWithTree(db: TraceDB, turn: Turn, after: string): Turn {
  const before = turn.before_tree ?? emptyTree(db.root);
  const diff = before === after ? "" : diffTrees(db.root, before, after);
  const ended = now();
  db.finishTurn(turn.id, after, diff, ended);
  pinTree(db.root, turn.id, "after", after);
  db.setMeta(LAST_SNAPSHOT, after);
  return { ...turn, after_tree: after, diff, ended_at: ended };
}

export function recordTool(db: TraceDB, sessionId: string, tool: string, file: string | null): void {
  const open = db.openTurn(sessionId);
  if (open) db.recordTool(open.id, tool, file, now());
}

/**
 * For agents that only report *after* a turn (Codex `notify`): we never saw the
 * before-state, so use the best baseline we have — the previous turn's after
 * snapshot in this session, else the last snapshot taken in this repo, else HEAD.
 * Human edits made between turns can get attributed to the agent in this mode;
 * `before_source` records which baseline was used so confidence can reflect it.
 */
export function recordCompletedTurn(
  db: TraceDB,
  opts: { sessionId: string; agent: string; prompt: string; externalId?: string },
): Turn {
  const prev = db.lastTurnInSession(opts.sessionId);
  let before: string;
  let source: string;
  if (prev?.after_tree) {
    before = prev.after_tree;
    source = "previous-turn";
  } else if (db.getMeta(LAST_SNAPSHOT)) {
    before = db.getMeta(LAST_SNAPSHOT)!;
    source = "last-snapshot";
  } else {
    before = headTree(db.root) ?? emptyTree(db.root);
    source = "head";
  }
  const a = author(db.root);
  const turn: Turn = {
    id: randomUUID(),
    session_id: opts.sessionId,
    agent: opts.agent,
    author_name: a.name,
    author_email: a.email,
    prompt: opts.prompt,
    prompt_redacted: redact(opts.prompt),
    before_tree: before,
    after_tree: null,
    before_source: source,
    diff: null,
    started_at: now(),
    ended_at: null,
    origin: "local",
  };
  db.insertTurn(turn);
  pinTree(db.root, turn.id, "before", before);
  return closeWithTree(db, turn, snapshot(db.root));
}
