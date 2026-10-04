import { customType, pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

export const executionModeEnum = pgEnum("execution_mode", ["dev", "prod"]);

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

export const timestamps = {
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const tenantId = () => uuid("tenant_id").notNull();
