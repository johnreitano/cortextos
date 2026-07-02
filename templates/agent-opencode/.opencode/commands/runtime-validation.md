---
description: Validate OpenCode runtime surfaces inside Cortext
agent: build
---

Run a local runtime validation report for this OpenCode Cortext agent. Do not build, restart, deploy, merge, delete data, or contact external services unless the user explicitly approved that action.

Check and report:

1. Runtime identity: `config.json` has `runtime: "opencode"` and the expected model.
2. OpenCode paths: run `opencode debug paths` and confirm state/config/cache are agent-isolated.
3. Skills: run `opencode debug skill` if available, and confirm Cortext skills are discoverable from `.opencode/skills`.
4. MCP: run `opencode mcp list` as a read-only status check.
5. Cortext bus: run `cortextos bus list-agents` and `cortextos bus list-crons $CTX_AGENT_NAME`.
6. Safety: confirm Telegram replies still go through `cortextos bus send-telegram`.

Return a concise pass/fail table with exact command outputs or error summaries.
