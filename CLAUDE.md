# CLAUDE.md

> **Start with [`AGENTS.md`](AGENTS.md).** It is the canonical repo-wide contract
> (product boundaries, subsystem map, quality gate, non-negotiables). Everything
> else orbits that file.

This file exists so Claude Code's default project-memory loader has an explicit
pointer. The canonical content lives in:

- [`AGENTS.md`](AGENTS.md) — canonical rules.
- [`SKILLS.md`](SKILLS.md) — index of project-local skills.

Claude Code bootstrap, navigation, agents, commands, and hooks live under a
local-only `.claude/` directory (`.claude/CLAUDE.md`, `.claude/docs/agent-navigation.md`,
…). That directory is gitignored and not part of the repository.

For the nearest directory-local rules when editing code, see
[`apps/engine/AGENTS.md`](apps/engine/AGENTS.md),
[`apps/sk/AGENTS.md`](apps/sk/AGENTS.md), and
[`packages/shared/AGENTS.md`](packages/shared/AGENTS.md).
