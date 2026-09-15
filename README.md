# Pi Agent Monorepo

Canonical source for Sergio's Pi agent configuration, selected upstream projects, personal overrides, and Learn project configuration.

The repository uses one Git history. Upstream code is imported beneath `upstream/` with subtree provenance; effective configuration lives separately under `config/`. See [architecture](docs/architecture.md) and [inventory](docs/inventory.md).

Private canonical remote: `https://github.com/pergioa/pi-agent-monorepo`

## Bootstrap and verify

```bash
cd "$HOME/studio code/pi-agent-monorepo"
./scripts/bootstrap --backup-root "$HOME/pi-agent-migration-backup-20260911-123000"
./scripts/verify
```

`bootstrap` installs locked dependencies, deploys explicit managed symlinks, and runs local verification. `verify` also checks GitHub forks and the private remote; use `./scripts/verify --local` before GitHub setup.

## Launch

Ordinary Pi:

```bash
pi
```

Learn (approve the project resources on the first launch):

```bash
cd "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Uni-notes"
pi --approve
```

Interactive subagents require Pi to run inside tmux:

```bash
tmux new-session -A -s pi-agent
pi
```

Learn research is hybrid and local-first. Routine teaching automatically uses
the Ollama-backed `researcher`. Difficult, high-stakes, conflicting, or
unresolved questions may escalate to the separately named OpenRouter-backed
`deep-researcher`; routine work does not call both. They can also be selected
manually inside Pi:

```text
/subagent researcher <question>
/subagent deep-researcher <question and unresolved local findings>
```

Inside Pi, browser automation and observational memory are both opt-in:

```text
/browser on
/om on
```

Their explicit off commands are `/browser off` and `/om off`.

## Update and redeploy

Synchronize the personal forks from the author's repositories and subtree-pull them into this monorepo:

```bash
cd "$HOME/studio code/pi-agent-monorepo"
./scripts/sync-upstreams
git status
./scripts/install-dependencies
./scripts/deploy
./scripts/verify
git push origin main
```

Review upstream changes before committing, especially where `overrides/README.md` identifies a local compatibility layer.

## Roll back

Rollback is non-destructive: it moves the current managed state into the backup before restoring the audited snapshot. Current credentials, sessions, and generated model catalog are not replaced.

```bash
cd "$HOME/studio code/pi-agent-monorepo"
./scripts/rollback "$HOME/pi-agent-migration-backup-20260911-123000"
```

## Credentials

The main workflow and Learn's default researcher use Ollama and need no hosted-provider secret. Learn's optional `deep-researcher` uses `openrouter/z-ai/glm-5.3`; its visual makers use `openrouter/anthropic/claude-sonnet-5`. These hosted agents require OpenRouter authentication when used. No effective configuration routes a model directly through the Anthropic provider.

The managed Ollama model definitions declare vision and reasoning support for
`qwen3.6:35b-a3b-coding` and `qwen3.8:27b-mlx`, so Pi passes image attachments
and rendered tool output to either local model. The visual makers remain on
OpenRouter unless their agent definitions are changed explicitly.

`web_search` uses Brave Search. Put the Brave key in the empty
`brave_search_api_key` field in
`config/global/extensions/web-search/auth.json`. This local file is ignored by
Git and must remain mode `0600`. Alternatively, provide
`BRAVE_SEARCH_API_KEY` in Pi's environment. Verify the configured key with:

```bash
cd "$HOME/studio code/pi-agent-monorepo"
./scripts/verify-web-search
```

No credential is invented or committed by this repository.

The deployment, verification, and rollback scripts default to this Obsidian
vault as the active Learn project. To target a different Learn project for one
run, set `PI_LEARN_DIR` to its absolute path.
