# CLAUDE.md

> **Start with [`AGENTS.md`](AGENTS.md).** It is the canonical repo-wide contract
> (product boundaries, subsystem map, quality gate, non-negotiables). Everything
> else orbits that file.

This file exists so Claude Code's default project-memory loader has an explicit
pointer. The real content lives in:

- [`AGENTS.md`](AGENTS.md) — canonical rules.
- [`SKILLS.md`](SKILLS.md) — index of project-local skills.
- [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — bootstrap index for agents, commands, hooks.
- [`.claude/docs/agent-navigation.md`](.claude/docs/agent-navigation.md) — task → subsystem map.

**Strategy & positioning docs** (read these for product framing, vocabulary, category claims):

- [`docs/thesis.md`](docs/thesis.md) — Document A: *why this category exists.*
- [`docs/system-requirements.md`](docs/system-requirements.md) — Document B: *what such a system must do.*
- [`docs/positioning.md`](docs/positioning.md) — Document C: *how sk realises it.*

For the nearest directory-local rules when editing code, see
[`apps/engine/AGENTS.md`](apps/engine/AGENTS.md),
[`apps/sk/AGENTS.md`](apps/sk/AGENTS.md), and
[`packages/shared/AGENTS.md`](packages/shared/AGENTS.md).
