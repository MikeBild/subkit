// Shared primitives used by every schema file in P1.
//
// - `bytea` column helper (drizzle-orm has no native bytea type, so we use
//   `customType`). All encryption columns are typed as Uint8Array in JS.
// - `timestamps` helper: `created_at` + `updated_at`, both `timestamptz`
//   with `defaultNow()`.
// - `tenantId` helper: non-null uuid column. FK set at the callsite where
//   the import order allows it.

import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

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

/**
 * Standard `created_at` + `updated_at` columns. Both `timestamptz`, both
 * default to `now()`. `updated_at` is maintained at the service layer — we
 * do NOT install a trigger in P1.
 */
export const timestamps = {
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const tenantId = () => uuid("tenant_id").notNull();
