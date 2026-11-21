import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DeviceCommandState } from "../../devices/core/command-state.ts";
import { bytea, timestamps } from "./_common.ts";
import { cockpitInstallations } from "./cockpit-installations.ts";
import { conversations } from "./conversations.ts";
import { executions } from "./executions.ts";
import { tenants, users } from "./identity.ts";

export const deviceRunners = pgTable(
  "device_runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    installation_id: uuid("installation_id")
      .notNull()
      .references(() => cockpitInstallations.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    device_label: text("device_label").notNull(),
    public_key: text("public_key").notNull(),
    enrolled_at: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    revoked_reason: text("revoked_reason"),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    app_version: text("app_version"),
    stop_generation: integer("stop_generation").notNull().default(0),
    reported_stop_generation: integer("reported_stop_generation").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("device_runners_active_installation_key")
      .on(t.tenant_id, t.installation_id)
      .where(sql`${t.revoked_at} IS NULL`),
    index("device_runners_tenant_owner_idx").on(t.tenant_id, t.owner_user_id),
    check("device_runners_label_check", sql`char_length(${t.device_label}) BETWEEN 1 AND 120`),
    check("device_runners_public_key_check", sql`char_length(${t.public_key}) BETWEEN 1 AND 512`),
    check(
      "device_runners_generation_check",
      sql`${t.stop_generation} >= 0 AND ${t.reported_stop_generation} >= 0 AND ${t.reported_stop_generation} <= ${t.stop_generation}`,
    ),
    check(
      "device_runners_revoked_check",
      sql`(${t.revoked_at} IS NULL) = (${t.revoked_reason} IS NULL)`,
    ),
    check(
      "device_runners_capabilities_check",
      sql`jsonb_typeof(${t.capabilities}) = 'object' AND octet_length(${t.capabilities}::text) <= 4096`,
    ),
  ],
);

export const deviceAllowances = pgTable(
  "device_allowances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    device_runner_id: uuid("device_runner_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"folder" | "site" | "app" | "keep_out">(),
    item_id: text("item_id").notNull(),
    display: text("display").notNull(),
    digest: text("digest"),
    access: text("access").$type<"read" | "write">(),
    private: boolean("private"),
    keep_out_target: text("keep_out_target").$type<"folder" | "app">(),
    entered_by: text("entered_by").notNull().$type<"person" | "approval">(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removed_at: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("device_allowances_active_item_key")
      .on(t.device_runner_id, t.kind, t.item_id)
      .where(sql`${t.removed_at} IS NULL`),
    index("device_allowances_tenant_runner_idx").on(t.tenant_id, t.device_runner_id),
    check("device_allowances_kind_check", sql`${t.kind} IN ('folder', 'site', 'app', 'keep_out')`),
    check("device_allowances_entered_by_check", sql`${t.entered_by} IN ('person', 'approval')`),
    check(
      "device_allowances_size_check",
      sql`char_length(${t.item_id}) BETWEEN 1 AND 300 AND char_length(${t.display}) BETWEEN 1 AND 1024`,
    ),
    check(
      "device_allowances_digest_check",
      sql`(${t.kind} = 'keep_out') = (${t.digest} IS NULL) AND (${t.digest} IS NULL OR ${t.digest} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      "device_allowances_shape_check",
      sql`(${t.kind} = 'folder') = (${t.access} IS NOT NULL) AND (${t.access} IS NULL OR ${t.access} IN ('read', 'write')) AND (${t.kind} = 'site') = (${t.private} IS NOT NULL) AND (${t.kind} = 'keep_out') = (${t.keep_out_target} IS NOT NULL) AND (${t.keep_out_target} IS NULL OR (${t.keep_out_target} IN ('folder', 'app') AND ${t.entered_by} = 'person')) AND (${t.kind} <> 'site' OR NOT ${t.private} OR ${t.entered_by} = 'person')`,
    ),
  ],
);

export const deviceRunnerNonces = pgTable(
  "device_runner_nonces",
  {
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    device_runner_id: uuid("device_runner_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    nonce: text("nonce").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.device_runner_id, t.nonce] }),
    index("device_runner_nonces_expiry_idx").on(t.tenant_id, t.device_runner_id, t.expires_at),
    check("device_runner_nonces_nonce_check", sql`${t.nonce} ~ '^[A-Za-z0-9_-]{22}$'`),
  ],
);

export const deviceCommands = pgTable(
  "device_commands",
  {
    id: text("id").primaryKey(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    execution_id: uuid("execution_id").references(() => executions.id, { onDelete: "cascade" }),
    task_run_id: uuid("task_run_id"),
    conversation_id: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    step_id: text("step_id").notNull(),
    authority_id: uuid("authority_id"),
    manifest_digest: text("manifest_digest"),
    kind: text("kind").notNull().$type<DeviceCommandKind>(),
    effect: text("effect").notNull().$type<"read" | "write">(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().$type<DeviceCommandState>(),
    generation: integer("generation").notNull(),
    attempt: integer("attempt").notNull().default(1),
    deadline_at: timestamp("deadline_at", { withTimezone: true }).notNull(),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    last_progress_at: timestamp("last_progress_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("device_commands_tenant_device_state_idx").on(t.tenant_id, t.device_id, t.state),
    index("device_commands_tenant_execution_idx").on(t.tenant_id, t.execution_id),
    check("device_commands_id_check", sql`${t.id} ~ '^[a-f0-9]{64}$'`),
    check(
      "device_commands_owner_check",
      sql`num_nonnulls(${t.execution_id}, ${t.task_run_id}, ${t.conversation_id}) = 1`,
    ),
    check(
      "device_commands_state_check",
      sql`${t.state} IN ('pending', 'claimed', 'done', 'refused', 'confirmation_required', 'failed', 'stopped', 'cancelled', 'lost', 'expired', 'revoked')`,
    ),
    check("device_commands_effect_check", sql`${t.effect} IN ('read', 'write')`),
    check(
      "device_commands_counts_check",
      sql`${t.generation} >= 0 AND ${t.attempt} BETWEEN 1 AND 2 AND char_length(${t.step_id}) BETWEEN 1 AND 300 AND char_length(${t.kind}) BETWEEN 1 AND 40`,
    ),
    check(
      "device_commands_size_check",
      sql`octet_length(${t.args}::text) <= 262144 AND (${t.result} IS NULL OR octet_length(${t.result}::text) <= 1048576)`,
    ),
    check(
      "device_commands_finished_check",
      sql`(${t.state} IN ('pending', 'claimed')) = (${t.finished_at} IS NULL)`,
    ),
  ],
);

export const deviceUploads = pgTable(
  "device_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    command_id: text("command_id")
      .notNull()
      .references(() => deviceCommands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    state: text("state").notNull().$type<"open" | "committed" | "aborted" | "expired">(),
    file_id: uuid("file_id"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("device_uploads_tenant_command_idx").on(t.tenant_id, t.command_id),
    check(
      "device_uploads_state_check",
      sql`${t.state} IN ('open', 'committed', 'aborted', 'expired') AND (${t.state} = 'committed') = (${t.file_id} IS NOT NULL)`,
    ),
    check(
      "device_uploads_size_check",
      sql`${t.size_bytes} BETWEEN 0 AND 94371840 AND char_length(${t.name}) BETWEEN 1 AND 255`,
    ),
  ],
);

export const deviceUploadChunks = pgTable(
  "device_upload_chunks",
  {
    upload_id: uuid("upload_id")
      .notNull()
      .references(() => deviceUploads.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.upload_id, t.n] }),
    index("device_upload_chunks_tenant_idx").on(t.tenant_id, t.upload_id),
    check(
      "device_upload_chunks_size_check",
      sql`${t.n} BETWEEN 0 AND 4095 AND octet_length(${t.bytes}) <= 4194304`,
    ),
  ],
);

export const deviceWaits = pgTable(
  "device_waits",
  {
    execution_id: uuid("execution_id")
      .primaryKey()
      .references(() => executions.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    device_id: uuid("device_id")
      .notNull()
      .references(() => deviceRunners.id, { onDelete: "cascade" }),
    waiting_since: timestamp("waiting_since", { withTimezone: true }).notNull(),
    cap_at: timestamp("cap_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("device_waits_tenant_device_idx").on(t.tenant_id, t.device_id),
    check("device_waits_cap_check", sql`${t.cap_at} > ${t.waiting_since}`),
  ],
);
