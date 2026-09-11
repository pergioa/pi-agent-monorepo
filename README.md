# Pi Agent Monorepo

Canonical source for Sergio's Pi agent configuration, selected upstream projects, personal overrides, and Learn project configuration.

The repository uses one Git history. Upstream code is imported beneath `upstream/` with subtree provenance; effective configuration lives separately under `config/`. See [architecture](docs/architecture.md) and [inventory](docs/inventory.md).

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
cd "$HOME/studio code/learn"
pi --approve
```

Interactive subagents require Pi to run inside tmux:

```bash
tmux new-session -A -s pi-agent
pi
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

Rollback is non-destructive: it moves the current managed state into the backup before restoring the audited snapshot. Current credentials, sessions, and model metadata are not replaced.

```bash
cd "$HOME/studio code/pi-agent-monorepo"
./scripts/rollback "$HOME/pi-agent-migration-backup-20260911-123000"
```

## Credentials

The main Ollama workflow needs no new hosted-provider secret. Learn's project researcher still names its upstream OpenRouter model, and web search still expects local Google Custom Search credentials. Neither credential is invented or committed by this repository.
