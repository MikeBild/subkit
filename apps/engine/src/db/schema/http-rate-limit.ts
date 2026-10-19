import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const httpRateLimitBuckets = pgTable(
  "http_rate_limit_buckets",
  {
    bucket_key: text("bucket_key").notNull(),
    window_started_at: timestamp("window_started_at", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket_key, t.window_started_at] }),
    index("http_rate_limit_buckets_expiry_idx").on(t.expires_at),
    check("http_rate_limit_buckets_hits_check", sql`${t.hits} > 0`),
  ],
);
