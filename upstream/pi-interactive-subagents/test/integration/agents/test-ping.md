---
name: test-ping
description: Integration test agent that asks the parent a question before completing
model: anthropic/claude-haiku-4-5
tools: bash
disable-model-invocation: true
---

Call ask_question once with the question "Approve this integration test?". Stop and wait.
After the parent replies, run the exact file-writing command from the original task and then finish.
