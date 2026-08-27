# SubKit Agent Guide

Canonical repo-wide instructions for the SubKit engine and CLI. Closer AGENTS.md files override this guide.

## Product boundaries

- Preserve the engine, CLI, shared-package, contribution, approval, and deployment boundaries.
- Extend behavior through the documented contribution format rather than creating parallel sources of truth.
- Keep the repository independent of the private deployment implementation.
- Preserve human approval semantics and deterministic execution.

## Sources and workflow

Read touched code, the nearest AGENTS.md, and the smallest relevant docs. Use:
- README.md for product orientation
- SKILLS.md for project-local skills
- apps/engine/AGENTS.md for engine work
- apps/sk/AGENTS.md for CLI work
- packages/shared/AGENTS.md for shared contracts
- docs/developers/agent-navigation.md for the detailed former root guide

Prefer focused changes, existing abstractions, and generated-source workflows. Never discard unrelated dirty-worktree state.

## Non-negotiable rules

- Maintain strict boundaries between transport, domain, persistence, and execution.
- Preserve approval gates and interaction-mode behavior.
- Never commit credentials, local configuration, or generated secrets.
- Do not hand-edit generated artifacts when a generator exists.
- Keep shared guidance in AGENTS.md or closer directory guides, not Claude-only memory.
- Follow repository language and formatting conventions.

## Validation

Run the narrowest relevant checks while iterating and the documented repository gate before completion when dependencies are available. Report any skipped validation.

Task-aware context is defined by .agent-prime.json. Use $prime or /prime after a real scope change.
