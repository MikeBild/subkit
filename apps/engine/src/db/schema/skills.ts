import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const skillScopeEnum = pgEnum("skill_scope", ["global", "connector", "workflow"]);
export const skillLifecycleEnum = pgEnum("skill_lifecycle", ["draft", "active", "archived"]);
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
    ...timestamps,
  },
  (t) => [
    index("skills_tenant_scope_connector_idx").on(t.tenant_id, t.scope, t.connector_id),
    index("skills_tenant_scope_workflow_idx").on(t.tenant_id, t.scope, t.workflow_id),
  ],
);

// ----- H3: Skill Candidates — deterministic self-improving skills ------------
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
]);

export const skillCandidates = pgTable(
  "skill_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    scope: skillScopeEnum("scope").notNull(),
    connector_id: uuid("connector_id"),
    workflow_id: uuid("workflow_id"),
    pattern_kind: skillCandidatePatternEnum("pattern_kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    examples: jsonb("examples"), // same SkillExamplesBlob shape as skills
    evidence: jsonb("evidence").notNull(), // structured evidence summary
    confidence: skillCandidateConfidenceEnum("confidence").notNull(),
    status: skillCandidateStatusEnum("status").notNull().default("proposed"),
    promoted_skill_id: uuid("promoted_skill_id").references(() => skills.id),
    fingerprint: text("fingerprint").notNull(), // deterministic dedup key
    version: integer("version").notNull().default(1),
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
  (t) => [index("skill_candidate_evidence_candidate_idx").on(t.skill_candidate_id)],
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
