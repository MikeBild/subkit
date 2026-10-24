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
import type { SkillRule } from "../../skills/types.ts";
import { catalogMetadata, catalogMetadataConstraints, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const skillScopeEnum = pgEnum("skill_scope", ["global", "connector", "workflow"]);
export const skillLifecycleEnum = pgEnum("skill_lifecycle", ["draft", "active", "archived"]);
export const SKILL_APPLIES_TO = ["chat", "authoring", "both"] as const;
export type SkillAppliesTo = (typeof SKILL_APPLIES_TO)[number];
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
    ...catalogMetadata(),
    examples: jsonb("examples"),
    arguments: jsonb("arguments"),
    lifecycle: skillLifecycleEnum("lifecycle").notNull(),
    source: skillSourceEnum("source").notNull().default("manual"),
    version: integer("version").notNull().default(1),
    seed_source: text("seed_source"),
    slug: text("slug"),
    gates_tools: jsonb("gates_tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    activates_when: jsonb("activates_when").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    input_schema: jsonb("input_schema").$type<Record<string, unknown> | null>(),
    output_schema: jsonb("output_schema").$type<Record<string, unknown> | null>(),
    side_effects: text("side_effects").notNull().default("read"),
    idempotency: text("idempotency").notNull().default("none"),
    maturity: text("maturity").notNull().default("stable"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    applies_to: text("applies_to").$type<SkillAppliesTo>().notNull().default("both"),
    rules: jsonb("rules").$type<SkillRule[]>().notNull().default(sql`'[]'::jsonb`),
    domains: jsonb("domains").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (t) => [
    index("skills_tenant_scope_connector_idx").on(t.tenant_id, t.scope, t.connector_id),
    index("skills_tenant_scope_workflow_idx").on(t.tenant_id, t.scope, t.workflow_id),
    uniqueIndex("skills_tenant_slug_uq").on(t.tenant_id, t.slug).where(sql`${t.slug} IS NOT NULL`),
    check("skills_idempotency_chk", sql`${t.idempotency} IN ('none','naturally','key_required')`),
    check("skills_maturity_chk", sql`${t.maturity} IN ('experimental','stable')`),
    check("skills_applies_to_chk", sql`${t.applies_to} IN ('chat','authoring','both')`),
    check("skills_rules_array_chk", sql`jsonb_typeof(${t.rules}) = 'array'`),
    check("skills_domains_array_chk", sql`jsonb_typeof(${t.domains}) = 'array'`),
    check(
      "skills_side_effects_chk",
      sql`${t.side_effects} IN ('none','read','write','destructive')`,
    ),
    ...catalogMetadataConstraints("skills", t),
  ],
);

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

export const skillCandidateStatusEnum = pgEnum("skill_candidate_status", [
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "context",
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
  "authoring_capability",
  "session_learning",
  "connector_capability",
  "knowledge_learning",
]);

export const skillCandidates = pgTable(
  "skill_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    scope: skillScopeEnum("scope").notNull(),
    connector_id: uuid("connector_id"),
    endpoint_key: text("endpoint_key"),
    workflow_id: uuid("workflow_id"),
    pattern_kind: skillCandidatePatternEnum("pattern_kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    examples: jsonb("examples"),
    evidence: jsonb("evidence").notNull(),
    confidence: skillCandidateConfidenceEnum("confidence").notNull(),
    status: skillCandidateStatusEnum("status").notNull().default("proposed"),
    promoted_skill_id: uuid("promoted_skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    fingerprint: text("fingerprint").notNull(),
    version: integer("version").notNull().default(1),
    tags: text("tags").array().notNull().default([]),
    proposed_by_user_id: uuid("proposed_by_user_id"),
    proposed_by_system_account_id: uuid("proposed_by_system_account_id"),
    ...timestamps,
  },
  (t) => [
    index("skill_candidates_tenant_status_idx").on(t.tenant_id, t.status),
    index("skill_candidates_tenant_connector_idx").on(t.tenant_id, t.connector_id),
    index("skill_candidates_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
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
    execution_id: uuid("execution_id"),
    patch_candidate_id: uuid("patch_candidate_id"),
    evidence_type: text("evidence_type").notNull(),
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
