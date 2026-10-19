import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./_common.ts";
import { tenants } from "./identity.ts";

export const runtimeConfigRevisionStatusEnum = pgEnum("runtime_config_revision_status", [
  "saved",
  "preparing",
  "active",
  "failed",
  "restart_required",
]);

export const runtimeConfigReplicaAckStatusEnum = pgEnum("runtime_config_replica_ack_status", [
  "idle",
  "preparing",
  "ack",
  "nack",
]);

export const runtimeConfigRevisions = pgTable(
  "runtime_config_revisions",
  {
    revision: bigserial("revision", { mode: "number" }).primaryKey(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    digest: text("digest").notNull(),
    status: runtimeConfigRevisionStatusEnum("status").default("saved").notNull(),
    pending_restart_fields: jsonb("pending_restart_fields").$type<string[]>().default([]).notNull(),
    failure_reason: text("failure_reason"),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activated_at: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [index("runtime_config_revisions_digest_idx").on(t.digest)],
);

export interface EngineRestartRequest {
  request_id: string;
  audit_id: string;
  tenant_id: string;
  actor_type: "user" | "system_account";
  actor_id: string;
  from_boot_id: string;
  expected_revision: number;
  requested_at: string;
  outcome?: "completed" | "failed";
  closed_at?: string;
  to_boot_id?: string;
}

export const runtimeConfigState = pgTable("runtime_config_state", {
  key: text("key").primaryKey(),
  active_revision: bigint("active_revision", { mode: "number" }),
  desired_revision: bigint("desired_revision", { mode: "number" }),
  master_key_epoch: bigint("master_key_epoch", { mode: "number" }).default(0).notNull(),
  master_key_digest: text("master_key_digest"),
  vault_maintenance_binding: jsonb("vault_maintenance_binding").$type<Record<
    string,
    unknown
  > | null>(),
  vault_maintenance_context: jsonb("vault_maintenance_context").$type<Record<
    string,
    unknown
  > | null>(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const engineRestartRequests = pgTable("engine_restart_requests", {
  key: text("key").primaryKey(),
  request: jsonb("request").$type<EngineRestartRequest>().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runtimeConfigReplicas = pgTable(
  "runtime_config_replicas",
  {
    instance_id: text("instance_id").primaryKey(),
    product_version: text("product_version").notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    active_revision: bigint("active_revision", { mode: "number" }),
    desired_revision: bigint("desired_revision", { mode: "number" }),
    ack_revision: bigint("ack_revision", { mode: "number" }),
    ack_digest: text("ack_digest"),
    ack_status: runtimeConfigReplicaAckStatusEnum("ack_status").default("idle").notNull(),
    ack_reason: text("ack_reason"),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("runtime_config_replicas_lease_idx").on(t.last_seen_at)],
);

export const runtimeSecretVersions = pgTable(
  "runtime_secret_versions",
  {
    tenant_id: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    pending_since: timestamp("pending_since", { withTimezone: true }),
    prepared_by: text("prepared_by"),
    pending_bindings: jsonb("pending_bindings").$type<string[] | null>(),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.version] }),
    index("runtime_secret_versions_name_idx").on(t.name),
  ],
);
