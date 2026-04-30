# Agent contract skills

Markdown files compiled into the **agent system prompt at build time**.
Loaded by `conversations/agent/context.ts` as immutable contract rules.

**Audience:** the LLM at every turn, regardless of tenant.

**Contract:**
- These are **not** tenant-overridable. An operator cannot suspend or shadow
  them via the skills table.
- Examples: `confirmation-discipline.md`, `chat-first-contract.md`,
  `error-recovery-and-rbac.md`. They encode invariants of the agent — not
  domain knowledge.
- Edits here ship to every tenant on the next deploy.

**vs `seed/skills/`:** that directory holds tenant-overridable knowledge
(per-connector hints, OAuth flows, multi-step best practices) loaded into
the database. If guidance is connector- or workflow-specific, put it
there. If it's a behavioural rule the agent must always obey, put it here.
