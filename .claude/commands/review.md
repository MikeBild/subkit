---
description: Structured code review of the current diff against main, via domain-architect.
---

Review the current branch's diff against `main` through the lens of subkit's
non-negotiables (from `AGENTS.md`).

Steps:

1. Collect the diff: `git diff main...HEAD` (and `git status` for untracked files).
2. Invoke the `domain-architect` sub-agent with the diff + a request to audit for:
   - **Tenant isolation** — every new query/response carries `tenant_id`.
   - **Audit** — every state change writes an `audit_log` entry with the right
     action type and request source.
   - **Zod discipline** — every new boundary (route, MCP tool, webhook, CLI input)
     has a Zod schema; OpenAPI is not hand-edited.
   - **RBAC** — every new route / MCP tool has an explicit permission.
   - **Structured logger** — no `console.*` in engine/CLI/agent/sk code.
   - **Sandboxing** — any untrusted JS goes through `apps/engine/src/sandboxes/`.
   - **Skill / Patch / Proposal approval** — no auto-promotion or auto-apply.
   - **Tests** — appropriate layer selected, negative tests for RBAC / tenant.
3. Report findings in the format:
   - **CRITICAL** (contract violations: tenant leak, audit bypass, RBAC missing,
     secrets logged, auto-promotion).
   - **WARNING** (Zod drift risk, missing test coverage, unstructured logger).
   - **SUGGESTION** (naming, duplication, simpler existing pattern).
   - **PASS** (what the change gets right).

Do not modify files — this is a review, not a fix. Suggest specific file:line edits
the user (or another agent) should make.
