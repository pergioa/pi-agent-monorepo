# Pi Agent Monorepo

Personal [Pi](https://github.com/badlogic/pi-mono) setup with one Git history: managed global configuration, a Learn project, and locally maintained upstream packages. `config/` contains the effective setup; `upstream/` contains imported sources; `overrides/` records local differences. See [architecture](docs/architecture.md) for the deployment layout.

## Features

- **Models and agents:** OpenAI Codex (`gpt-6-sol`, high thinking) is the global default. Local Ollama models support reasoning and images; agent profiles can select other models, including OpenRouter.
- **Subagents:** Asynchronous `scout`, `researcher`, and `worker` profiles run headlessly with restricted tools; interactive profiles use tmux. Spawn with `/subagent <agent> <task>`, inspect live output with `/subagents` or `Ctrl+Alt+S`, and send follow-ups by name with `subagent_message`. Forked sessions, nested delegation, question/answer handoffs, and restricted resume are supported. [Details](upstream/pi-interactive-subagents/README.md).
- **Observational memory:** Opt-in session memory with local Ollama observation and consolidation (`/om on`, `/om off`).
- **Global tools and skills:** Brave web search, web fetch, browser automation (`/browser on`), guarded shell commands, prompt snippets, question popups, PDF reading, web debugging, video transcripts, and session analysis.
- **Assignment coach:** `/coach start <task>` starts a guided coding workflow; `/coach mode guided|pair|demo` selects the level of hands-on help. `/coach stop` exits. The coach stays inactive outside an assignment.
- **Learn project:** Guided teaching and quizzes, local-first research with optional hosted escalation, diagrams, Markdown session logs, and linked Obsidian concept notes (`/learn-notes start <topic>`). [Details](config/projects/learn/README.md).

## Use and maintain

```bash
./scripts/bootstrap --backup-root "$HOME/pi-agent-backup" # install, deploy managed links, verify
pi                                                    # ordinary session
./scripts/verify --local                              # check local installation
```

Learn runs from the Obsidian vault at `$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Uni-notes` by default; set `PI_LEARN_DIR` to target a different project. Start Pi inside tmux only when you want visible interactive subagents.

`./scripts/sync-upstreams` updates the imported projects; `./scripts/install-dependencies`, `./scripts/deploy`, and `./scripts/verify` refresh and check the installation. `./scripts/rollback <migration-snapshot-dir>` restores the original migration snapshot. Credentials, sessions, memory, and browser state stay outside Git. Hosted agents need local OpenRouter authentication; Brave search needs `BRAVE_SEARCH_API_KEY` or an ignored `config/global/extensions/web-search/auth.json`.
