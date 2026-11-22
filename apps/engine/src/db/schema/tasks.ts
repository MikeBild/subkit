import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  catalogMetadata,
  catalogMetadataConstraints,
  executionModeEnum,
  tenantId,
  timestamps,
} from "./_common.ts";
import { conversationMessages, conversations } from "./conversations.ts";
import { tenants } from "./identity.ts";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ...catalogMetadata(),
    owner_id: uuid("owner_id").notNull(),
    goal: text("goal").notNull(),
    done_when: text("done_when").notNull(),
    goal_edited_by: uuid("goal_edited_by"),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    bindings: jsonb("bindings")
      .$type<{
        workflow_ids: string[];
        connector_ids: string[];
        skill_slugs: string[];
        web_search: boolean;
      }>()
      .notNull(),
    environment: executionModeEnum("environment").notNull(),
    schedule_cron: text("schedule_cron"),
    schedule_timezone: text("schedule_timezone"),
    schedule_run_at: timestamp("schedule_run_at", { withTimezone: true }),
    last_claimed_at: timestamp("last_claimed_at", { withTimezone: true }),
    admission_hold_reason: text("admission_hold_reason"),
    admission_hold_since: timestamp("admission_hold_since", { withTimezone: true }),
    schedule_anchor_at: timestamp("schedule_anchor_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paused_at: timestamp("paused_at", { withTimezone: true }),
    paused_by: uuid("paused_by"),
    paused_reason: text("paused_reason").$type<"owner_request" | "admin" | "owner_unavailable">(),
    max_turns: integer("max_turns").notNull().default(20),
    run_deadline_minutes: integer("run_deadline_minutes").notNull().default(240),
    fingerprint: text("fingerprint").notNull(),
    revision: integer("revision").notNull().default(1),
    lifecycle: text("lifecycle").$type<"active" | "archived">().notNull().default("active"),
    locale: text("locale").$type<"de" | "en">().notNull(),
    source_conversation_id: uuid("source_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    source_message_id: uuid("source_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tasks_tenant_id_key").on(t.tenant_id, t.id),
    index("tasks_tenant_owner_idx").on(t.tenant_id, t.owner_id),
    index("tasks_tenant_source_conversation_idx")
      .on(t.tenant_id, t.source_conversation_id)
      .where(sql`${t.source_conversation_id} IS NOT NULL`),
    ...catalogMetadataConstraints("tasks", t),
    check("tasks_lifecycle_check", sql`${t.lifecycle} IN ('active', 'archived')`),
    check("tasks_locale_check", sql`${t.locale} IN ('de', 'en')`),
    check("tasks_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check("tasks_revision_check", sql`${t.revision} >= 1`),
    check("tasks_limits_check", sql`${t.max_turns} >= 1 AND ${t.run_deadline_minutes} >= 1`),
    check(
      "tasks_documents_check",
      sql`jsonb_typeof(${t.plan}) = 'object' AND jsonb_typeof(${t.bindings}) = 'object'`,
    ),
    check("tasks_schedule_check", sql`${t.schedule_cron} IS NULL OR ${t.schedule_run_at} IS NULL`),
    check(
      "tasks_admission_hold_check",
      sql`(${t.admission_hold_reason} IS NULL AND ${t.admission_hold_since} IS NULL) OR (${t.admission_hold_since} IS NOT NULL AND ${t.admission_hold_reason} IN ('grant_required', 'grant_expired', 'grant_exhausted', 'grant_fingerprint_mismatch', 'owner_unavailable', 'ai_access_missing', 'previous_run_active', 'paused'))`,
    ),
    check(
      "tasks_paused_check",
      sql`(${t.paused_at} IS NULL AND ${t.paused_by} IS NULL AND ${t.paused_reason} IS NULL) OR (${t.paused_at} IS NOT NULL AND ${t.paused_reason} IN ('owner_request', 'admin', 'owner_unavailable'))`,
    ),
  ],
);

export const taskRuns = pgTable(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    task_id: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    task_revision: integer("task_revision").notNull(),
    fingerprint: text("fingerprint").notNull(),
    conversation_id: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    trigger: text("trigger").$type<"manual" | "once" | "cron">().notNull(),
    started_by: uuid("started_by"),
    grant_id: uuid("grant_id"),
    state: text("state")
      .$type<
        "running" | "waiting" | "sleeping" | "result_ready" | "completed" | "aborted" | "failed"
      >()
      .notNull(),
    waiting_reason: text("waiting_reason").$type<
      | "question"
      | "approval"
      | "no_progress"
      | "budget"
      | "question_expired"
      | "ai_access"
      | "turn_stopped"
    >(),
    next_check_at: timestamp("next_check_at", { withTimezone: true }),
    sleep_reason: text("sleep_reason"),
    deadline_at: timestamp("deadline_at", { withTimezone: true }).notNull(),
    turns_used: integer("turns_used").notNull().default(0),
    no_progress_count: integer("no_progress_count").notNull().default(0),
    last_seen_turn_id: uuid("last_seen_turn_id"),
    last_seen_turn_seq: integer("last_seen_turn_seq").notNull().default(0),
    turn_job_failures: integer("turn_job_failures").notNull().default(0),
    budget_wait_tokens: integer("budget_wait_tokens"),
    rejected_playbook_revision: integer("rejected_playbook_revision"),
    last_playbook_revision: integer("last_playbook_revision").notNull().default(0),
    progress_marks: jsonb("progress_marks").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    trace_id: text("trace_id").notNull(),
    failure_code: text("failure_code"),
    result_ready_at: timestamp("result_ready_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    completed_by: uuid("completed_by"),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("task_runs_tenant_id_key").on(t.tenant_id, t.id),
    index("task_runs_tenant_task_created_idx").on(t.tenant_id, t.task_id, t.created_at.desc()),
    index("task_runs_tenant_conversation_idx").on(t.tenant_id, t.conversation_id),
    uniqueIndex("task_runs_one_run_per_conversation_key")
      .on(t.tenant_id, t.conversation_id)
      .where(sql`${t.conversation_id} IS NOT NULL`),
    uniqueIndex("task_runs_one_open_run_key")
      .on(t.tenant_id, t.task_id)
      .where(sql`${t.state} IN ('running', 'waiting', 'sleeping')`),
    index("task_runs_tenant_wake_idx")
      .on(t.tenant_id, t.next_check_at)
      .where(sql`${t.state} = 'sleeping'`),
    check("task_runs_trigger_check", sql`${t.trigger} IN ('manual', 'once', 'cron')`),
    check(
      "task_runs_state_check",
      sql`${t.state} IN ('running', 'waiting', 'sleeping', 'result_ready', 'completed', 'aborted', 'failed')`,
    ),
    check(
      "task_runs_waiting_reason_check",
      sql`${t.waiting_reason} IS NULL OR ${t.waiting_reason} IN ('question', 'approval', 'no_progress', 'budget', 'question_expired', 'ai_access', 'turn_stopped')`,
    ),
    check(
      "task_runs_sleep_reason_check",
      sql`${t.sleep_reason} IS NULL OR char_length(${t.sleep_reason}) <= 200`,
    ),
    check(
      "task_runs_failure_code_check",
      sql`${t.failure_code} IS NULL OR char_length(${t.failure_code}) <= 200`,
    ),
    check("task_runs_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check("task_runs_trace_id_check", sql`${t.trace_id} ~ '^[0-9a-f]{32}$'`),
    check(
      "task_runs_counters_check",
      sql`${t.task_revision} >= 1 AND ${t.turns_used} >= 0 AND ${t.no_progress_count} >= 0 AND ${t.last_playbook_revision} >= 0`,
    ),
    check("task_runs_progress_marks_check", sql`jsonb_typeof(${t.progress_marks}) = 'array'`),
  ],
);

export const taskGrants = pgTable(
  "task_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    task_id: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    fingerprint: text("fingerprint").notNull(),
    environment: executionModeEnum("environment").notNull(),
    valid_from: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    valid_until: timestamp("valid_until", { withTimezone: true }),
    max_runs: integer("max_runs"),
    reserved_runs: integer("reserved_runs").notNull().default(0),
    created_by: uuid("created_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_by: uuid("revoked_by"),
    workflow_authority_ids: jsonb("workflow_authority_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiry_notified_at: timestamp("expiry_notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("task_grants_tenant_id_key").on(t.tenant_id, t.id),
    index("task_grants_tenant_task_idx").on(t.tenant_id, t.task_id),
    uniqueIndex("task_grants_one_unrevoked_key")
      .on(t.tenant_id, t.task_id, t.environment)
      .where(sql`${t.revoked_at} IS NULL`),
    check("task_grants_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      "task_grants_window_check",
      sql`${t.valid_until} IS NULL OR ${t.valid_until} > ${t.valid_from}`,
    ),
    check(
      "task_grants_run_limit_check",
      sql`${t.reserved_runs} >= 0 AND (${t.max_runs} IS NULL OR (${t.max_runs} > 0 AND ${t.reserved_runs} <= ${t.max_runs}))`,
    ),
    check(
      "task_grants_revocation_check",
      sql`(${t.revoked_at} IS NULL) = (${t.revoked_by} IS NULL)`,
    ),
    check(
      "task_grants_authorities_check",
      sql`jsonb_typeof(${t.workflow_authority_ids}) = 'array' AND jsonb_array_length(${t.workflow_authority_ids}) <= 200 AND octet_length(${t.workflow_authority_ids}::text) <= 8192`,
    ),
  ],
);
