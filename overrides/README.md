# Personal Overrides

Effective configuration lives under `config/` so upstream synchronization does not silently replace personal behavior.

- `config/global/settings.json` owns model selection, local package references, and observational-memory tuning; `config/global/ollama-models.json` owns the non-secret local model capabilities deployed as Pi's `models.json`.
- `config/global/agents/` owns the Ollama agent frontmatter overrides.
- `config/global/extensions/` preserves the secured dependency locks from the effective installation and replaces the retired Google-backed search implementation with Brave Search.
- `config/projects/learn/` preserves the Learn dependency updates, omits its duplicate global extension, implements local-first research with a separately named hosted fallback, routes its Claude visual makers through OpenRouter instead of Anthropic directly, translates Pi-style LaTeX delimiters in `md-log` output so math renders in Obsidian, and adds structured topic/concept Obsidian notebooks with agent-declared semantic routing.
- `upstream/pi-interactive-subagents/package-lock.json` carries the locally generated root-version metadata correction required for a clean locked install.
- The imported pi-config README is sanitized to keep the repository within the migration's explicit component boundary.

When a subtree sync changes any corresponding upstream file, review the difference against these effective copies before redeploying.
