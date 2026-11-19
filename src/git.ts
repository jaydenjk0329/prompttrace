import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const NOTES_REF = "refs/notes/prompttrace";

export function git(cwd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  }) as string;
}

export function tryGit(cwd: string, args: string[], opts: ExecFileSyncOptions = {}): string | null {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

/** Repo root for a directory, or null if not inside a git work tree. */
export function repoRoot(cwd: string): string | null {
  const out = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return out ? out.trim() : null;
}

export function gitPath(root: string, name: string): string {
  const p = git(root, ["rev-parse", "--git-path", name]).trim();
  return isAbsolute(p) ? p : resolve(root, p);
}

export function emptyTree(root: string): string {
  return git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).trim();
}

export function headTree(root: string): string | null {
  const out = tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  return out ? out.trim() : null;
}

/**
 * Snapshot the working tree (tracked + untracked, honoring .gitignore) into a
 * git tree object without touching the user's real index.
 */
export function snapshot(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prompttrace-"));
  const idx = join(dir, "index");
  try {
    const realIndex = gitPath(root, "index");
    // Seed from the real index so `add -A` only rehashes changed files.
    if (existsSync(realIndex)) copyFileSync(realIndex, idx);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    git(root, ["add", "-A", "--", "."], { env });
    return git(root, ["write-tree"], { env }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Keep tree objects reachable so `git gc` never prunes them. */
export function pinTree(root: string, turnId: string, which: "before" | "after", tree: string): void {
  tryGit(root, ["update-ref", `refs/prompttrace/turns/${turnId}/${which}`, tree]);
}

export function diffTrees(root: string, before: string, after: string): string {
  return git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", before, after]);
}

export function author(root: string): { name: string; email: string } {
  return {
    name: (tryGit(root, ["config", "user.name"]) ?? "").trim() || "unknown",
    email: (tryGit(root, ["config", "user.email"]) ?? "").trim(),
  };
}

export function lineHash(line: string): string {
  return createHash("sha1").update(line.trim()).digest("hex").slice(0, 16);
}

/** Lines too generic to identify a change on their own ("}", "", "end", ...). */
export function isTrivialLine(line: string): boolean {
  const t = line.trim();
  return t.length < 3 || /^[\s{}()\[\];,]*$/.test(t);
}

export interface FileHunk {
  file: string;
  newStart: number;
  newLen: number;
  added: string[];
}

/** Parse a unified diff into per-file hunks with their added lines. */
export function parseDiff(diff: string): FileHunk[] {
  const hunks: FileHunk[] = [];
  let file: string | null = null;
  let cur: FileHunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      cur = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      file = p === "/dev/null" ? null : unquote(p).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      if (!file) {
        cur = null;
        continue;
      }
      cur = { file, newStart: Number(m[1]), newLen: m[2] === undefined ? 1 : Number(m[2]), added: [] };
      hunks.push(cur);
      continue;
    }
    if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return hunks;
}

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

/** Filter a full unified diff down to the given files. */
export function filterDiff(diff: string, files: Set<string>): string {
  const parts = diff.split(/^(?=diff --git )/m);
  return parts
    .filter((part) => {
      const m = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part) ?? /^--- (?:a\/)?(.+)$/m.exec(part);
      return m ? files.has(unquote(m[1]).replace(/^[ab]\//, "")) : false;
    })
    .join("");
}

export interface BlameResult {
  sha: string; // all zeros for uncommitted
  origLine: number;
  origFile: string;
  content: string;
}

export function blameLine(root: string, file: string, line: number): BlameResult | null {
  const out = tryGit(root, ["blame", "-w", "-M", "--porcelain", "-L", `${line},${line}`, "--", file]);
  if (!out) return null;
  const lines = out.split("\n");
  const [sha, origLine] = lines[0].split(" ");
  const fileLine = lines.find((l) => l.startsWith("filename "));
  const content = lines.find((l) => l.startsWith("\t"));
  return {
    sha,
    origLine: Number(origLine),
    origFile: fileLine ? fileLine.slice("filename ".length) : file,
    content: content ? content.slice(1) : "",
  };
}

export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

export function commitFiles(root: string, sha: string): string[] {
  const out = git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-M", sha]);
  return out.split("\n").filter(Boolean);
}

export function commitInfo(root: string, sha: string): { sha: string; subject: string; author: string; date: string } | null {
  const out = tryGit(root, ["show", "-s", "--format=%H%x00%s%x00%an <%ae>%x00%aI", sha]);
  if (!out) return null;
  const [full, subject, a, date] = out.trim().split("\0");
  return { sha: full, subject, author: a, date };
}

export function readNote(root: string, sha: string): string | null {
  return tryGit(root, ["notes", `--ref=${NOTES_REF}`, "show", sha]);
}

export function writeNote(root: string, sha: string, content: string): void {
  git(root, ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", sha], { input: content });
}

export function listNotes(root: string): Array<{ note: string; commit: string }> {
  const out = tryGit(root, ["notes", `--ref=${NOTES_REF}`, "list"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [note, commit] = l.split(" ");
      return { note, commit };
    });
}

export function catBlob(root: string, sha: string): string {
  return git(root, ["cat-file", "-p", sha]);
}

/** Normalize a user-supplied path (absolute or cwd-relative) to repo-relative. */
export function repoRelative(root: string, cwd: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(root, abs).split("\\").join("/");
}
