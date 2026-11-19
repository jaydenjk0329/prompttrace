# prompttrace

**`git blame`, but for prompts.** Find which coding-agent prompt produced any line, file or commit — yours or a teammate's.

Works with **Claude Code** and **Codex** (automatic capture via hooks), and any MCP client (manual fallback).

```
$ prompttrace blame src/math.ts:6
src/math.ts:6    return a * b;
  confidence: line
  b3492e6b Jayden <jayden@…> claude · 11/19/2026, 12:17 PM · 6c8c0f94

  > In math.ts, add an exported function multiply(a: number, b: number) …
```

## How it works

1. **Capture.** On every prompt, a hook snapshots your working tree into a git tree object, using a temporary index so your staged changes are never touched. When the agent stops, it snapshots again and records the diff. Because it compares snapshots, it catches every change the agent made: edit tools, shell commands, codegen and formatters.
2. **Store.** Turns (prompt, author, agent, diff) live in `.prompttrace/trace.db`, a local SQLite file that is git-excluded.
3. **Share.** A `post-commit` hook attaches each commit's prompts as a **git note** (`refs/notes/prompttrace`). Prompts and diffs in notes are **secret-redacted**. Only committed work is shared, and only when you run `prompttrace notes push`.
4. **Query.** `git blame` finds the commit, then the turn inside it whose added lines match. Uncommitted lines are matched against local turns.

## Setup

```sh
npm install -g @jaydenjk0329/prompt-trace   # Node >= 22.13 — installs the `prompttrace` command
                                            # (or one-off: npx @jaydenjk0329/prompt-trace install)
cd your-repo
prompttrace install               # Claude Code + Codex + git hooks
```

`install` merges into existing config and never overwrites it:

| What | Where |
|---|---|
| Claude Code hooks | `.claude/settings.json` (`--local` for `settings.local.json`) |
| Codex hooks | `.codex/hooks.json`. Run `/hooks` in Codex once to trust them |
| MCP server | `.mcp.json` (Claude Code), `.codex/config.toml` (Codex) |
| Agent instructions | `.claude/skills/prompt-trace/SKILL.md`, `AGENTS.md` |
| Commit linking | `.git/hooks/post-commit`, `notes.rewriteRef` (notes survive amend/rebase) |

Commit `.claude/`, `.codex/`, `.mcp.json` and `AGENTS.md` so the whole team is captured. Git hooks aren't versioned, so each teammate runs `prompttrace install --git-hooks` once.

## Seeing each other's prompting

```sh
prompttrace notes push            # share your committed prompts (redacted)
prompttrace notes fetch           # pull teammates' prompts into your local DB

prompttrace log --author sam      # what has Sam been asking agents to do?
prompttrace log --file src/auth.ts
prompttrace search "rate limit"
prompttrace export --html trace.html   # static, filterable timeline to share
```

## Commands

| | |
|---|---|
| `blame <file>[:line[-end]] [--diff]` | Which prompt(s) produced this code |
| `show <turn-id>` | Full prompt, tools used, diff |
| `commit <sha>` | Prompts behind a commit |
| `log`, `search` | Browse, filter or search everyone's prompts |
| `notes push / fetch / import` | Team sharing via git notes |
| `export --html <file>` | Shareable HTML timeline |
| `mcp` | MCP server (stdio) |
| `uninstall` | Remove hooks and MCP registration |

Every command takes `--json`.

## MCP tools

`trace_line`, `trace_range`, `trace_file`, `trace_commit`, `list_turns`, `get_turn`, `search_prompts`, `list_authors`. There is also `begin_turn` / `end_turn` for agents without hook support.

## Confidence levels

| | |
|---|---|
| `line` | The exact line content was added by this turn, in the commit `git blame` points to |
| `in-progress` | Added by a turn that is still running |
| `uncommitted` | Local and uncommitted; matches a line this turn added |
| `commit` | This turn is in the blamed commit and touched the file, but this exact line wasn't matched |
| `none` | No recorded prompt (written by hand, or before prompttrace was installed) |

Lines like `}` or blank lines take their attribution from the nearest meaningful line, reported as `via_line`.

## Privacy

- Raw prompts stay in your local DB.
- Notes and HTML exports use redacted prompts and diffs. Redaction covers API keys, tokens, private keys, `PASSWORD=`-style assignments and URL credentials.
- Redaction is best-effort, so review before you `notes push` in sensitive repos.
- Set `PROMPTTRACE_DISABLE=1` to pause capture.

## Known limits

- Edits *you* make while an agent turn is running are attributed to that turn.
- Snapshots respect `.gitignore`, so changes to ignored files aren't traced.
- Hook errors never interrupt the agent. They are logged to `.prompttrace/hook.log`.
