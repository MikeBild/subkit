# Seed skills

Markdown skill files loaded into the database at boot via `skills/seed.ts`.
Each tenant gets a copy on first boot; SHA-256 drift detection prevents
re-writes once an operator has edited a skill in their tenant.

**Audience:** the LLM at conversation time. These skills become first-class
rows in the `skills` table; the conversation loop pulls applicable ones into
the prompt based on scope (`global` / `connector` / `workflow`) and intent.

**Contract:**
- Each file has YAML frontmatter (`slug`, `scope`, `title`, `description`,
  `gates_tools`, `version`, `auto_load`, `trigger_keywords`).
- `slug` matches the database row's `slug` column and stays stable.
- Content rewrites bump `version`; tenants whose hash already drifted keep
  their copy.
- Tenant overrides shadow these via the `(tenant_id, slug)` unique key.

**vs `agent/skills/content/`:** that directory holds compiled-into-prompt
contract rules that are NOT tenant-overridable. Seed skills here are
tenant-overridable knowledge.
