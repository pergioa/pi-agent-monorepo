---
name: test-fork
description: Integration test agent with inherited conversation context
model: anthropic/claude-haiku-4-5
tools: read, bash, write, edit
session-mode: fork
auto-exit: true
disable-model-invocation: true
---

Complete the requested test task immediately and concisely.
