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

/**
 * Immutable, complete runtime-configuration documents. A revision includes
 * the global document and its tenant overlays so one pointer switch exposes
 * a coherent snapshot to every request path.
 */
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

/** Singleton pointer and activation request. */
export const runtimeConfigState = pgTable("runtime_config_state", {
  key: text("key").primaryKey(),
  active_revision: bigint("active_revision", { mode: "number" }),
  desired_revision: bigint("desired_revision", { mode: "number" }),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Lease plus prepare/ACK state for every live replica. A replica is healthy
 * while last_seen_at is within the coordinator lease window.
 */
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

/** Immutable encrypted secret versions referenced as secret://name/version. */
export const runtimeSecretVersions = pgTable(
  "runtime_secret_versions",
  {
    name: text("name").notNull(),
    version: integer("version").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    created_by: uuid("created_by"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    // A PREPARED version: written (by `engine --vault-set --pending` or by a
    // connection) but not yet approved by a person in the Cockpit. While set,
    // the version is not the current one, cannot be bound, and `--vault-check`
    // does not see it. Approval clears it and re-pins `pending_bindings`;
    // rejection revokes it.
    pending_since: timestamp("pending_since", { withTimezone: true }),
    /** Who or what prepared it, in words the Cockpit shows ("Host-Kommando", "Verbindung wiki"). */
    prepared_by: text("prepared_by"),
    /** Dotted settings paths to re-point at this version on approval. */
    pending_bindings: jsonb("pending_bindings").$type<string[] | null>(),
  },
  (t) => [
    primaryKey({ columns: [t.name, t.version] }),
    index("runtime_secret_versions_name_idx").on(t.name),
  ],
);
