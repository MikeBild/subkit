import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const externalCallMetering = pgTable(
  "external_call_metering",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    operation: text("operation"),
    units: integer("units").notNull().default(0),
    cost_usd: numeric("cost_usd", { precision: 12, scale: 6 }),
    latency_ms: integer("latency_ms").notNull().default(0),
    result: text("result").$type<"ok" | "error">().notNull(),
    error: text("error"),
    created_at: timestamps.created_at,
    month_bucket: bigint("month_bucket", { mode: "number" }).notNull(),
    execution_id: uuid("execution_id"),
    conversation_id: uuid("conversation_id"),
  },
  (t) => [
    index("external_call_metering_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("external_call_metering_tenant_provider_month_idx").on(
      t.tenant_id,
      t.provider,
      t.month_bucket,
    ),
    index("external_call_metering_execution_idx").on(t.tenant_id, t.execution_id),
    check("external_call_metering_result_check", sql`${t.result} IN ('ok','error')`),
    check("external_call_metering_provider_slug_check", sql`${t.provider} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);
