---
name: prompt-trace
description: Find which coding-agent prompt (and which teammate) produced a line, file, or commit — "why is this code like this?", "which prompt added X?", "what did <person> ask the agent to do?", or before reverting/rewriting agent-written code. Uses the prompttrace MCP tools.
---

# prompt-trace

This repo records every prompt given to a coding agent (Claude Code, Codex) along with the exact code changes it produced. Teammates' prompts are shared through git notes on their commits.

## When to use
- The user asks *why/when/who* changed some code, or *which prompt* produced it.
- The user wants to see what they — or a teammate — asked the agent to do ("show me Sam's prompts on the auth module").
- Before reverting, rewriting, or "fixing" code an agent wrote: check the original prompt so you don't undo intended behavior.

## Tools (MCP server `prompttrace`)
| Question | Tool |
|---|---|
| Which prompt wrote this line / these lines? | `trace_line(file, line)` / `trace_range(file, start, end)` |
| History of prompts that touched a file | `trace_file(file)` |
| Prompts behind a commit | `trace_commit(sha)` |
| Browse by person / agent / time / file | `list_turns(author?, agent?, file?, since?)` |
| Find a prompt by words in it | `search_prompts(query)` |
| Full detail (prompt, tools used, diff) | `get_turn(id)` |
| Who has traces here | `list_authors()` |

## How to answer
- Quote the prompt (short ones in full, long ones trimmed), and give the author, agent, time, short turn id, and commit.
- Report the `confidence`: `line` = exact match in the blamed commit; `in-progress` / `uncommitted` = local, not yet committed; `commit` = same commit and file, but this exact line wasn't matched; `none` = no recorded prompt (probably written by hand or before tracing was installed). Don't overstate a weak match.
- If `alternatives` is non-empty, mention that earlier turns added identical content.
- Teammates' prompts are already redacted. Don't try to recover redacted values.

## Fallback capture
Use `begin_turn` / `end_turn` only if the user says hooks aren't set up for this agent.
