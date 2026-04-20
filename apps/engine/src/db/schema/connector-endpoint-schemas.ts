import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { connectors } from "./connectors.ts";
import { tenants } from "./identity.ts";

export const connectorEndpointSchemas = pgTable(
  "connector_endpoint_schemas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    connector_id: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    method: text("method").notNull(),
    request_schema: jsonb("request_schema"),
    query_schema: jsonb("query_schema"),
    response_schema: jsonb("response_schema"),
    expected_statuses: integer("expected_statuses").array(),
    idempotent: boolean("idempotent").notNull().default(false),
    description: text("description"),
    source: text("source").notNull().default("manual"),
    confidence: integer("confidence").notNull().default(0),
    extracted_at: timestamp("extracted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("connector_endpoint_schemas_tenant_connector_idx").on(t.tenant_id, t.connector_id),
    uniqueIndex("conn_ep_schemas_method_path_uq").on(t.connector_id, t.method, t.path),
  ],
);
