# CLAUDE.md

> **Start with [`AGENTS.md`](AGENTS.md).** It is the canonical repo-wide contract
> (product boundaries, subsystem map, quality gate, non-negotiables). Everything
> else orbits that file.

This file exists so Claude Code's default project-memory loader has an explicit
pointer. The real content lives in:

- [`AGENTS.md`](AGENTS.md) — canonical rules.
- [`SKILLS.md`](SKILLS.md) — index of project-local skills.
- [`.claude/CLAUDE.md`](.claude/CLAUDE.md) — bootstrap index for agents, commands, hooks.
- [`docs/00-agent-navigation.md`](docs/00-agent-navigation.md) — task → subsystem map.

For the nearest directory-local rules when editing code, see
[`apps/engine/AGENTS.md`](apps/engine/AGENTS.md),
[`apps/cli/AGENTS.md`](apps/cli/AGENTS.md),
[`apps/sk/AGENTS.md`](apps/sk/AGENTS.md),
[`apps/agent/AGENTS.md`](apps/agent/AGENTS.md), and
[`packages/shared/AGENTS.md`](packages/shared/AGENTS.md).
