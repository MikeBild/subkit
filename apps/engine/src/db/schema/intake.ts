import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";

const subkit = pgSchema("subkit");

export const intakeItemStateEnum = subkit.enum("intake_item_state", [
  "collected",
  "reviewing",
  "admitted",
  "discarded",
]);

export const intakeProposalStatusEnum = subkit.enum("intake_proposal_status", [
  "draft",
  "stale",
  "confirmed",
  "rejected",
]);

interface IntakeSnapshotFields {
  title: string;
  source_author?: string | undefined;
  published_at?: string | undefined;
  captured_at: string;
  body: string;
  redactions?: number | undefined;
}

export interface IntakeCaptureSnapshot extends IntakeSnapshotFields {
  origin: "capture" | "restored_draft";
  source_url: string;
}

export interface IntakeSessionSnapshot extends IntakeSnapshotFields {
  origin: "session";
  source_url?: string | undefined;
  agent: string;
  session_id: string;
  repo: string | null;
  domains: string[];
  evidence_excerpt: string;
  learning_kind?: "practice" | "fact" | undefined;
  scope?: "global" | "connector" | "workflow" | undefined;
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
  tags?: string[] | undefined;
}

export interface IntakeNoteSnapshot extends IntakeSnapshotFields {
  origin: "note";
  source_url?: undefined;
}

export type IntakeCollectedSnapshot = IntakeCaptureSnapshot | IntakeNoteSnapshot;

export type IntakeSnapshot = IntakeCollectedSnapshot | IntakeSessionSnapshot;

export type IntakeTargetKind = "knowledge" | "skill";

export interface IntakeNewSkill {
  title: string;
  scope: "global" | "connector" | "workflow";
  connector_id?: string | undefined;
  workflow_id?: string | undefined;
  tags: string[];
  category: string;
}

export interface IntakeSkillTarget {
  skill: {
    skill_id?: string | undefined;
    expected_version?: number | undefined;
    new?: IntakeNewSkill | undefined;
    supersedes: { skill_id: string; expected_version: number }[];
  };
}

export type IntakeKnowledgeTarget =
  | { knowledge_source_id: string; expected_version: string }
  | { name: string; category?: string | undefined; tags?: string[] | undefined };

export type IntakeProposalTarget = IntakeKnowledgeTarget | IntakeSkillTarget;

export const intakeCategoryDefaults = subkit.table(
  "intake_category_defaults",
  {
    tenant_id: tenantId(),
    actor_type: text("actor_type").notNull(),
    actor_id: uuid("actor_id").notNull(),
    category: text("category").notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("intake_category_defaults_actor_key").on(t.tenant_id, t.actor_type, t.actor_id),
    check(
      "intake_category_defaults_actor_type_check",
      sql`${t.actor_type} IN ('user', 'system_account')`,
    ),
    index("intake_category_defaults_tenant_category_idx").on(t.tenant_id, t.category),
  ],
);

export const intakeItems = subkit.table(
  "intake_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId(),
    category: text("category").notNull(),
    client_request_id: uuid("client_request_id").notNull(),
    creation_request_digest: text("creation_request_digest").notNull(),
    original_snapshot: jsonb("original_snapshot").$type<IntakeSnapshot>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    note: text("note").notNull().default(""),
    state: intakeItemStateEnum("state").notNull().default("collected"),
    version: integer("version").notNull().default(1),
    collected_by_type: text("collected_by_type").notNull(),
    collected_by_id: uuid("collected_by_id").notNull(),
    admitted_target_kind: text("admitted_target_kind").$type<IntakeTargetKind>(),
    admitted_target_id: uuid("admitted_target_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("intake_items_tenant_request_key").on(t.tenant_id, t.client_request_id),
    index("intake_items_tenant_category_updated_idx").on(t.tenant_id, t.category, t.updated_at),
    index("intake_items_tenant_state_updated_idx").on(t.tenant_id, t.state, t.updated_at),
    check(
      "intake_items_collected_by_type_check",
      sql`${t.collected_by_type} IN ('user', 'system_account')`,
    ),
    check(
      "intake_items_admitted_target_check",
      sql`(${t.admitted_target_kind} IS NULL AND ${t.admitted_target_id} IS NULL) OR (${t.admitted_target_kind} IN ('knowledge', 'skill') AND ${t.admitted_target_id} IS NOT NULL)`,
    ),
  ],
);

export const intakeItemEvidence = subkit.table(
  "intake_item_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId(),
    item_id: uuid("item_id")
      .notNull()
      .references(() => intakeItems.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    session_id: text("session_id").notNull(),
    repo: text("repo"),
    excerpt: text("excerpt").notNull(),
    captured_at: timestamp("captured_at", { withTimezone: true }).notNull(),
    recorded_by_type: text("recorded_by_type").notNull(),
    recorded_by_id: uuid("recorded_by_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("intake_item_evidence_item_session_key").on(t.tenant_id, t.item_id, t.session_id),
    index("intake_item_evidence_tenant_item_created_idx").on(t.tenant_id, t.item_id, t.created_at),
    check(
      "intake_item_evidence_recorded_by_type_check",
      sql`${t.recorded_by_type} IN ('user', 'system_account')`,
    ),
  ],
);

export const intakeProposals = subkit.table(
  "intake_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId(),
    status: intakeProposalStatusEnum("status").notNull().default("draft"),
    current_revision: integer("current_revision").notNull().default(1),
    confirmed_revision: integer("confirmed_revision"),
    confirmed_target_kind: text("confirmed_target_kind").$type<IntakeTargetKind>(),
    confirmed_target_id: uuid("confirmed_target_id"),
    rejected_at: timestamp("rejected_at", { withTimezone: true }),
    stale_reason: text("stale_reason"),
    ...timestamps,
  },
  (t) => [
    index("intake_proposals_tenant_status_updated_idx").on(t.tenant_id, t.status, t.updated_at),
    check(
      "intake_proposals_confirmed_target_check",
      sql`(${t.confirmed_target_kind} IS NULL AND ${t.confirmed_target_id} IS NULL) OR (${t.confirmed_target_kind} IN ('knowledge', 'skill') AND ${t.confirmed_target_id} IS NOT NULL)`,
    ),
  ],
);

export const intakeProposalRevisions = subkit.table(
  "intake_proposal_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId(),
    proposal_id: uuid("proposal_id")
      .notNull()
      .references(() => intakeProposals.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    target: jsonb("target").$type<IntakeProposalTarget>().notNull(),
    digest: text("digest").notNull(),
    created_by_type: text("created_by_type").notNull(),
    created_by_id: uuid("created_by_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("intake_proposal_revisions_revision_key").on(t.proposal_id, t.revision),
    uniqueIndex("intake_proposal_revisions_digest_key").on(t.proposal_id, t.digest),
    index("intake_proposal_revisions_tenant_proposal_idx").on(t.tenant_id, t.proposal_id),
    check(
      "intake_proposal_revisions_created_by_type_check",
      sql`${t.created_by_type} IN ('user', 'system_account')`,
    ),
  ],
);

export const intakeProposalItems = subkit.table(
  "intake_proposal_items",
  {
    tenant_id: tenantId(),
    proposal_revision_id: uuid("proposal_revision_id")
      .notNull()
      .references(() => intakeProposalRevisions.id, { onDelete: "cascade" }),
    item_id: uuid("item_id")
      .notNull()
      .references(() => intakeItems.id, { onDelete: "restrict" }),
    item_version: integer("item_version").notNull(),
    source_title: text("source_title").notNull(),
    source_url: text("source_url"),
  },
  (t) => [
    uniqueIndex("intake_proposal_items_revision_item_key").on(t.proposal_revision_id, t.item_id),
    index("intake_proposal_items_tenant_item_idx").on(t.tenant_id, t.item_id),
  ],
);
