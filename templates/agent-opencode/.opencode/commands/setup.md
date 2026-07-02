---
description: Run the Cortext onboarding setup flow
agent: build
---

Run the Cortext first-boot setup flow.

1. Check whether `${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded` exists.
2. If it exists, report that onboarding is already complete and summarize current goals.
3. If it is missing, read `plugins/cortextos-agent-skills/skills/onboarding/SKILL.md` and follow it exactly.
4. User-facing messages must use the exact `cortextos bus send-telegram` command shown in Telegram injections.
5. If the onboarding skill tells you to end your turn, stop work immediately.
