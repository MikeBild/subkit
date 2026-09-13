import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { bytea, tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const connectorTemplateCredentials = pgTable(
  "connector_template_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    template_slug: text("template_slug").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("connector_template_credentials_tenant_slug_key").on(t.tenant_id, t.template_slug),
  ],
);
