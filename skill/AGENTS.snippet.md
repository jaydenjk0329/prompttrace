<!-- prompttrace -->
## Prompt tracing
This repo records which agent prompt produced each code change (`prompttrace` MCP server). When asked why/when/who changed code, which prompt produced something, or what a teammate asked the agent to do — and before reverting agent-written code — use `trace_line`, `trace_range`, `trace_file`, `trace_commit`, `list_turns`, `search_prompts`, or `get_turn`. Quote the prompt, author, time, and turn id, and state the returned `confidence` honestly.
