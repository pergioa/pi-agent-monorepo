# Personal Overrides

Effective configuration lives under `config/` so upstream synchronization does not silently replace personal behavior.

- `config/global/settings.json` owns model selection, local package references, and observational-memory tuning.
- `config/global/agents/` owns the Ollama agent frontmatter overrides.
- `config/global/extensions/` preserves the secured dependency locks from the effective installation.
- `config/projects/learn/` preserves the Learn dependency updates and omits its duplicate global extension.
- `upstream/pi-interactive-subagents/package-lock.json` carries the locally generated root-version metadata correction required for a clean locked install.
- The imported pi-config README is sanitized to keep the repository within the migration's explicit component boundary.

When a subtree sync changes any corresponding upstream file, review the difference against these effective copies before redeploying.

