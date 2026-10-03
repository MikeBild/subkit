import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const skillScopeEnum = pgEnum("skill_scope", ["global", "connector", "workflow"]);
export const skillLifecycleEnum = pgEnum("skill_lifecycle", ["draft", "active", "archived"]);
// Where a skill is offered: the chat assistant, workflow drafting, or both.
export const SKILL_APPLIES_TO = ["chat", "authoring", "both"] as const;
export type SkillAppliesTo = (typeof SKILL_APPLIES_TO)[number];
// Provenance of a Skill row. Operators use this to distinguish
// handwritten ("manual") from pattern-promoted ("candidate") from
// connector-template-seeded ("template") from memory-ingested ("memory").
// Every row carries this value; `manual` is the default for existing
// rows on migration.
export const skillSourceEnum = pgEnum("skill_source", [
  "manual",
  "candidate",
  "template",
  "memory",
]);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    scope: skillScopeEnum("scope").notNull(),
    connector_id: uuid("connector_id"),
    workflow_id: uuid("workflow_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    examples: jsonb("examples"),
    // GC4: optional argument descriptors used by MCP completion/complete to
    // hint per-skill input names. Shape: [{name, description, enum?, default?}].
    arguments: jsonb("arguments"),
    lifecycle: skillLifecycleEnum("lifecycle").notNull(),
    source: skillSourceEnum("source").notNull().default("manual"),
    version: integer("version").notNull().default(1),
    // Conversation-quality extensions:
    //   seed_source — non-null when the row is managed by the disk seed loader
    //     (see skills/seed.ts). A manually edited skill should null this out.
    //   slug — stable cross-tenant identifier used by the seed loader and by
    //     `load_skill` callers. Unique per tenant when present.
    //   gates_tools — tool names that become invisible to the LLM until this
    //     skill is in `loaded_skills`. Read by conversations/tools/gated.ts
    //     to filter the tool palette per turn. Complementary to
    //     `activates_when` (which controls auto-loading).
    seed_source: text("seed_source"),
    slug: text("slug"),
    gates_tools: jsonb("gates_tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Skill metadata overhaul (migration 0006):
    //   activates_when — discriminated-union list of activation rules
    //     consumed by `apps/engine/src/conversations/skill-autoload.ts`. The
    //     matcher reads this column instead of a hand-maintained RULES table.
    //   input_schema / output_schema — optional JSONSchema; the workflow
    //     validator gate enforces structural superset when a workflow
    //     declares `derived_from_skill_id` pointing at this skill.
    //   side_effects / idempotency / maturity / tags — capability/safety
    //     contract surfaced into the assembled prompt and gating logic.
    activates_when: jsonb("activates_when").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    input_schema: jsonb("input_schema").$type<Record<string, unknown> | null>(),
    output_schema: jsonb("output_schema").$type<Record<string, unknown> | null>(),
    side_effects: text("side_effects").notNull().default("read"),
    idempotency: text("idempotency").notNull().default("none"),
    maturity: text("maturity").notNull().default("stable"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Which surface the skill is offered on: "chat" (the assistant),
    // "authoring" (workflow drafting) or "both".
    applies_to: text("applies_to").$type<SkillAppliesTo>().notNull().default("both"),
    ...timestamps,
  },
  (t) => [
    index("skills_tenant_scope_connector_idx").on(t.tenant_id, t.scope, t.connector_id),
    index("skills_tenant_scope_workflow_idx").on(t.tenant_id, t.scope, t.workflow_id),
    uniqueIndex("skills_tenant_slug_uq").on(t.tenant_id, t.slug).where(sql`${t.slug} IS NOT NULL`),
    check("skills_idempotency_chk", sql`${t.idempotency} IN ('none','naturally','key_required')`),
    check("skills_maturity_chk", sql`${t.maturity} IN ('experimental','stable')`),
    check("skills_applies_to_chk", sql`${t.applies_to} IN ('chat','authoring','both')`),
    check(
      "skills_side_effects_chk",
      sql`${t.side_effects} IN ('none','read','write','destructive')`,
    ),
  ],
);

// Per-tenant override for seed-managed skills (migration 0028). Operators can
// hide a seed skill or replace its body without touching the seed row. The
// skill-retrieval path joins against this table with a LEFT JOIN.
export const tenantSkillOverrides = pgTable(
  "tenant_skill_overrides",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    skill_slug: text("skill_slug").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    body_override: text("body_override"),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tenant_skill_overrides_pk_idx").on(t.tenant_id, t.skill_slug)],
);

// ----- Skill Candidates — deterministic self-improving skills ----------------
//
// Three tables for the observe → detect → propose → approve cycle:
//   - skill_candidates: proposed skill improvements from pattern detection.
//   - skill_candidate_evidence: links candidates to supporting executions/patches.
//   - skill_effectiveness: post-promotion correlation tracking.
//
// Candidates are NEVER auto-promoted. Every mutation goes through an explicit
// human gate (conversation approval or REST API).

export const skillCandidateStatusEnum = pgEnum("skill_candidate_status", [
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);

export const skillCandidateConfidenceEnum = pgEnum("skill_candidate_confidence", [
  "low",
  "medium",
  "high",
]);

export const skillCandidatePatternEnum = pgEnum("skill_candidate_pattern", [
  "repair_pattern",
  "failure_pattern",
  "success_pattern",
  "chained_workflow_pattern",
  // Authoring-time capability summary, proposed when an operator commits a
  // workflow. Distinct from success_pattern so its workflow-keyed supersede
  // (one live candidate per workflow) never collides with the run-derived
  // success detector's own supersede pass.
  "authoring_capability",
  // Learning captured from an external coding-agent session (Claude Code,
  // Codex): distilled from a SessionEnd transcript or proposed explicitly
  // via the `save_learning` tool. Always lands as `proposed` — the human
  // curation gate is the whole point of the capture loop.
  "session_learning",
  // Navigation guide for a connector authored from a description (no
  // template skill), built deterministically from its green probe: tools
  // with their read/write claim, data paths and paging named in the tool
  // descriptions. A decision like any other proposed candidate.
  "connector_capability",
]);

export const skillCandidates = pgTable(
  "skill_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    scope: skillScopeEnum("scope").notNull(),
    connector_id: uuid("connector_id"),
    // Endpoint within the connector this candidate is about, when the pattern
    // is interface-scoped (repair_pattern). Part of the candidate's logical
    // identity: two endpoints on the same connector are distinct candidates and
    // must not supersede each other (migration 0039). NULL for patterns that
    // aren't endpoint-specific (failure/success/chained).
    endpoint_key: text("endpoint_key"),
    workflow_id: uuid("workflow_id"),
    pattern_kind: skillCandidatePatternEnum("pattern_kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    examples: jsonb("examples"), // same SkillExamplesBlob shape as skills
    evidence: jsonb("evidence").notNull(), // structured evidence summary
    confidence: skillCandidateConfidenceEnum("confidence").notNull(),
    status: skillCandidateStatusEnum("status").notNull().default("proposed"),
    // set null on skill delete: the candidate's approved status is history
    // that must survive the promoted skill's removal (a plain reference
    // made DELETE /v1/skills/{id} 500 on any promoted skill).
    promoted_skill_id: uuid("promoted_skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    fingerprint: text("fingerprint").notNull(), // deterministic dedup key
    version: integer("version").notNull().default(1),
    // Carried onto the promoted skill on approve. Session learnings use
    // `domain:<slug>` tags so the promoted skill lands in the same domain
    // briefing that grounded the originating session.
    tags: text("tags").array().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    index("skill_candidates_tenant_status_idx").on(t.tenant_id, t.status),
    index("skill_candidates_tenant_connector_idx").on(t.tenant_id, t.connector_id),
    index("skill_candidates_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
    // Dedup of active proposals enforced at service layer (check fingerprint +
    // status = 'proposed' before insert). A full unique on (tenant, fingerprint)
    // is too restrictive — rejected candidates with the same fingerprint must
    // coexist with new proposals after evidence changes.
    index("skill_candidates_tenant_fingerprint_idx").on(t.tenant_id, t.fingerprint),
  ],
);

export const skillCandidateEvidence = pgTable(
  "skill_candidate_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skill_candidate_id: uuid("skill_candidate_id")
      .notNull()
      .references(() => skillCandidates.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id"), // FK enforced at service layer (nullable)
    patch_candidate_id: uuid("patch_candidate_id"), // FK enforced at service layer (nullable)
    evidence_type: text("evidence_type").notNull(), // patch_applied | step_failure | step_success
    summary: text("summary").notNull(),
    captured_at: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("skill_candidate_evidence_candidate_idx").on(t.skill_candidate_id),
    uniqueIndex("skill_candidate_evidence_identity_idx").on(
      t.skill_candidate_id,
      t.evidence_type,
      sql`coalesce(${t.execution_id}::text, '')`,
      sql`coalesce(${t.patch_candidate_id}::text, '')`,
      sql`(CASE WHEN ${t.execution_id} IS NULL AND ${t.patch_candidate_id} IS NULL THEN ${t.summary} ELSE '' END)`,
    ),
  ],
);

export const skillEffectiveness = pgTable(
  "skill_effectiveness",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    skill_id: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skill_candidate_id: uuid("skill_candidate_id")
      .notNull()
      .references(() => skillCandidates.id, { onDelete: "cascade" }),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    window_end: timestamp("window_end", { withTimezone: true }).notNull(),
    executions_before: integer("executions_before").notNull(),
    failures_before: integer("failures_before").notNull(),
    executions_after: integer("executions_after").notNull(),
    failures_after: integer("failures_after").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("skill_effectiveness_tenant_skill_idx").on(t.tenant_id, t.skill_id)],
);
