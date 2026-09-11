# Migration Inventory

Audited on 2026-09-11 with Pi 0.85.1, Node 24.18.0, npm 11.16.0, and Python 3.14.6.

## Canonical managed resources

- Global `settings.json`, three agent overrides, seven extension entries, and four skills.
- Local package sources for interactive subagents and observational memory.
- Learn's four agents, two skills, `md-log`, `quiz`, and `visual-tools` extensions.
- Locked JavaScript dependencies and the PDF Reader requirement file.

## Preserved local behavior

- Default and global agent model: `ollama/qwen3.6:35b-a3b-coding`.
- Observational-memory observer and consolidator: the same Ollama model.
- Observational-memory context threshold: 100000 tokens; session activation remains opt-in.
- `shell-quote` lock updated to 1.10.0.
- `@mozilla/readability` pinned to the compatible secured 0.6.0 release.
- Browser extension uses Playwright Core 1.60.0 with its matching Chromium installation.
- PDF Reader uses PyMuPDF 1.27.2.2 in its ignored local virtual environment.
- Learn retains secure Mermaid 11.17.2 transitive resolution, Mermaid CLI 11.16.0, Puppeteer 25.3.0, and its installed Chrome runtime.
- Learn's visual-tools no longer hardcodes a user or Node-version path. Dependency installation resolves the active global Pi package dynamically.
- Learn uses `ollama/qwen3.6:35b-a3b-coding` for routine research and retains `openrouter/z-ai/glm-5.3` as the selective `deep-researcher` fallback.
- Learn loads the one global ask-user-question implementation.

## Local-only state

The following stay in their original runtime locations and are ignored everywhere in this repository: `auth.json`, `sessions/`, model catalogs/stores, `.memory/`, browser profiles, caches, logs, dependency directories, virtual environments, and transient render files.

No OpenRouter or web-search-provider credential was created. Configure those only when desired using Pi/provider documentation and local untracked authentication. The local researcher does not require OpenRouter; the hosted fallback does.

## Original locations

The first migration backup is `/Users/sergioabreoalvarez/pi-agent-migration-backup-20260911-123000`. It is mode 0700 and contains complete pre-migration snapshots. Superseded clones are moved beneath its `superseded/` directory during cutover rather than deleted.

The active Learn project is the `Uni-notes` Obsidian vault at
`$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Uni-notes`; the
deployment scripts allow an alternate destination through `PI_LEARN_DIR`.
