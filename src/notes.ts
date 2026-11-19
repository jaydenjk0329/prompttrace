import { TraceDB, type Turn } from "./db.js";
import { NOTES_REF, catBlob, commitFiles, filterDiff, git, lineHash, listNotes, parseDiff, readNote, tryGit, writeNote } from "./git.js";
import { redact, truncate } from "./redact.js";

/** Max diff chars stored per turn in a shared note. */
const MAX_NOTE_DIFF = 200_000;
const MAX_NOTE_PROMPT = 20_000;

/** One JSON object per line, so `git notes merge -s cat_sort_uniq` merges cleanly. */
export interface NoteTurn {
  v: 1;
  id: string;
  session_id: string;
  agent: string;
  author: { name: string; email: string };
  prompt: string; // redacted
  started_at: string;
  ended_at: string | null;
  files: string[];
  diff: string; // limited to files in this commit, redacted
}

export function parseNote(content: string): NoteTurn[] {
  const out: NoteTurn[] = [];
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.v === 1 && typeof o.id === "string") out.push(o);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Called from the post-commit hook. Links finished local turns whose changes
 * touch files in this commit (and that weren't already committed for those
 * files), then writes a self-contained note onto the commit.
 */
export function linkCommit(db: TraceDB, sha = "HEAD"): NoteTurn[] {
  const full = git(db.root, ["rev-parse", sha]).trim();
  const files = new Set(commitFiles(db.root, full));
  if (files.size === 0) return [];

  const filesCache = new Map<string, string[]>();
  const filesOf = (c: string) => {
    if (!filesCache.has(c)) filesCache.set(c, tryGit(db.root, ["cat-file", "-e", c]) === null ? [] : commitFiles(db.root, c));
    return filesCache.get(c)!;
  };

  // Lines this commit adds, per file — a turn is only linked if its own added
  // lines show up here (so stale, never-committed turns don't get swept in).
  const commitAdded = new Map<string, Set<string>>();
  const parent = tryGit(db.root, ["rev-parse", "--verify", "--quiet", `${full}^`])?.trim();
  const commitDiff = git(db.root, parent ? ["diff", "--no-color", "-M", parent, full] : ["show", "--no-color", "--format=", full]);
  for (const h of parseDiff(commitDiff)) {
    const s = commitAdded.get(h.file) ?? new Set<string>();
    for (const l of h.added) s.add(lineHash(l));
    commitAdded.set(h.file, s);
  }
  const contributes = (turnId: string, file: string) => {
    const hashes = db.lineHashesFor(turnId, file);
    if (hashes.length === 0) return true; // deletion-only change to a committed file
    const added = commitAdded.get(file);
    return !!added && hashes.some((h) => added.has(h));
  };

  const linked: NoteTurn[] = [];
  for (const t of db.candidateTurnsForCommit()) {
    if (!t.diff) continue;
    const touched = db.filesForTurn(t.id).filter((f) => files.has(f) && contributes(t.id, f));
    if (touched.length === 0) continue;
    const already = new Set<string>();
    for (const c of db.commitsForTurn(t.id)) if (c !== full) for (const f of filesOf(c)) already.add(f);
    const fresh = touched.filter((f) => !already.has(f));
    if (fresh.length === 0) continue;
    db.linkCommit(t.id, full);
    linked.push(toNoteTurn(t, fresh));
  }

  if (linked.length) {
    // Merge with an existing note (e.g. re-run, or note copied over by amend).
    const existing = parseNote(readNote(db.root, full) ?? "");
    const byId = new Map(existing.map((n) => [n.id, n]));
    for (const n of linked) byId.set(n.id, n);
    writeNote(db.root, full, [...byId.values()].map((n) => JSON.stringify(n)).join("\n") + "\n");
  }
  return linked;
}

function toNoteTurn(t: Turn, files: string[]): NoteTurn {
  return {
    v: 1,
    id: t.id,
    session_id: t.session_id,
    agent: t.agent,
    author: { name: t.author_name, email: t.author_email },
    prompt: truncate(t.prompt_redacted || redact(t.prompt), MAX_NOTE_PROMPT),
    started_at: t.started_at,
    ended_at: t.ended_at,
    files,
    diff: truncate(redact(filterDiff(t.diff ?? "", new Set(files))), MAX_NOTE_DIFF),
  };
}

export function noteTurnToTurn(n: NoteTurn): Turn {
  return {
    id: n.id,
    session_id: n.session_id,
    agent: n.agent,
    author_name: n.author?.name ?? "unknown",
    author_email: n.author?.email ?? "",
    prompt: n.prompt,
    prompt_redacted: n.prompt,
    before_tree: null,
    after_tree: null,
    before_source: "note",
    diff: n.diff,
    started_at: n.started_at,
    ended_at: n.ended_at,
    origin: "imported",
  };
}

/** Import every prompttrace note in the repo into the local DB. */
export function importNotes(db: TraceDB): { notes: number; turns: number } {
  let turns = 0;
  const notes = listNotes(db.root);
  for (const { note, commit } of notes) {
    for (const n of parseNote(catBlob(db.root, note))) {
      if (db.importTurn(noteTurnToTurn(n), commit)) turns++;
    }
  }
  return { notes: notes.length, turns };
}

/** Import notes for one commit on demand (used by attribution). */
export function importCommitNote(db: TraceDB, sha: string): number {
  const content = readNote(db.root, sha);
  if (!content) return 0;
  let n = 0;
  for (const nt of parseNote(content)) if (db.importTurn(noteTurnToTurn(nt), sha)) n++;
  return n;
}

const REMOTE_TMP = (remote: string) => `refs/notes/prompttrace-remote/${remote}`;

export function fetchNotes(db: TraceDB, remote = "origin"): { notes: number; turns: number } {
  const tmp = REMOTE_TMP(remote);
  git(db.root, ["fetch", remote, `+${NOTES_REF}:${tmp}`]);
  const haveLocal = tryGit(db.root, ["rev-parse", "--verify", "--quiet", NOTES_REF]) !== null;
  if (haveLocal) {
    git(db.root, ["notes", `--ref=${NOTES_REF}`, "merge", "-s", "cat_sort_uniq", tmp]);
  } else {
    git(db.root, ["update-ref", NOTES_REF, tmp]);
  }
  return importNotes(db);
}

export function pushNotes(db: TraceDB, remote = "origin"): void {
  // Merge any remote notes first so the push is a fast-forward.
  const remoteHas = tryGit(db.root, ["ls-remote", remote, NOTES_REF]);
  if (remoteHas && remoteHas.trim()) fetchNotes(db, remote);
  git(db.root, ["push", remote, `${NOTES_REF}:${NOTES_REF}`]);
}
