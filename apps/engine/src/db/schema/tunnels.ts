import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const tunnelStateEnum = pgEnum("tunnel_state", ["registered", "connected", "disconnected"]);

export const tunnels = pgTable(
  "tunnels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    agent_token_sha256: text("agent_token_sha256").notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }),
    state: tunnelStateEnum("state").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("tunnels_tenant_name_key").on(t.tenant_id, t.name)],
);

export const tunnelTargets = pgTable(
  "tunnel_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    tunnel_id: uuid("tunnel_id")
      .notNull()
      .references(() => tunnels.id, { onDelete: "cascade" }),
    target_name: text("target_name").notNull(),
    concurrency_cap: integer("concurrency_cap").default(16).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("tunnel_targets_tunnel_target_key").on(t.tunnel_id, t.target_name)],
);
