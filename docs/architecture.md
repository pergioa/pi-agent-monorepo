# Architecture

This repository has one top-level Git history and no submodules or nested repositories.

## Layers

- `upstream/` contains imported source trees and their upstream histories or recorded snapshot commits.
- `config/global/` is the canonical source for managed global Pi settings, Ollama model definitions, agent overrides, extensions, and skills.
- `config/projects/learn/` is the canonical source for Learn's project-local Pi resources.
- `overrides/` documents why the effective configuration differs from the vendor trees.
- `scripts/` installs dependencies, deploys explicit links, verifies the machine, synchronizes sources, and rolls back.
- Pi credentials, sessions, the generated model catalog, generated memory, browser state, caches, and logs remain outside Git.

## Vendor provenance

| Prefix | Authoritative upstream | Initial import | Strategy |
| --- | --- | --- | --- |
| `upstream/pi-config` | `https://github.com/amosblomqvist/pi-config` | `f82da563ab05d66729492d64c7ed4e96db3663f3` | recorded snapshot; future subtree pulls |
| `upstream/pi-interactive-subagents` | `https://github.com/amosblomqvist/pi-interactive-subagents` | `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` | history-preserving subtree |
| `upstream/pi-observational-memory` | `https://github.com/amosblomqvist/pi-observational-memory` | `78a1efcfdd46332253fb289724f05b26dfc7769e` | history-preserving subtree |
| `upstream/learn` | `https://github.com/amosblomqvist/learn` | `7cfd8942f82ab9476e63572387e1fe9bcea5082c` | recorded snapshot; future subtree pulls |

The two recorded snapshots came from shallow local clones. Their exact commit IDs preserve provenance without manufacturing history. `scripts/sync-upstreams` first synchronizes each personal fork from the author repository, then performs a squashed subtree pull into the matching prefix.

Monorepo remotes:

- `origin`: `https://github.com/pergioa/pi-agent-monorepo.git` (private canonical repository)
- `fork-pi-config`: `https://github.com/pergioa/pi-config.git`
- `fork-pi-interactive-subagents`: `https://github.com/pergioa/pi-interactive-subagents.git`
- `fork-pi-observational-memory`: `https://github.com/pergioa/pi-observational-memory.git`
- `fork-learn`: `https://github.com/pergioa/learn.git`
- `upstream-pi-config`: `https://github.com/amosblomqvist/pi-config.git`
- `upstream-pi-interactive-subagents`: `https://github.com/amosblomqvist/pi-interactive-subagents.git`
- `upstream-pi-observational-memory`: `https://github.com/amosblomqvist/pi-observational-memory.git`
- `upstream-learn`: `https://github.com/amosblomqvist/learn.git`

## Deployment model

`scripts/deploy` calculates the repository root from its own location, so spaces in the path are safe. It creates absolute symlinks only for individual managed files or top-level resource entries. It does not replace `~/.pi/agent`, and it does not touch credentials, sessions, the generated `models-store.json` catalog, generated memory, caches, logs, or unrelated resources. The non-secret Ollama definitions are managed from `config/global/ollama-models.json` and deployed as `~/.pi/agent/models.json`.

Global package entries point at `./packages/...` beneath the Pi agent directory. Deployment links those two names to the monorepo vendor trees, making this checkout—not Pi's package cache—the runtime source.

Learn inherits the global ask-user-question extension. Its project tree intentionally omits the identical duplicate, preventing a second tool registration.

The active Learn deployment defaults to the `Uni-notes` Obsidian vault beneath
the current user's iCloud documents directory. `PI_LEARN_DIR` overrides that
destination without changing canonical content, and all path handling remains
quoted so spaces are safe.
