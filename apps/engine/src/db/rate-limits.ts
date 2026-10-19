import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Executor, getDb } from "./client.ts";

const limitInput = z
  .object({
    bucket_key: z.string().regex(/^[a-f0-9]{64}$/),
    max: z.number().int().min(1).max(1000000),
    window: z.enum(["minute", "month"]).default("minute"),
  })
  .strict();

type AdmissionResult =
  | { allowed: true }
  | { allowed: false; window: "minute" | "month"; retry_after_seconds: number };

export function rateLimitBucketKey(
  secret: string,
  scope: "global" | "peer" | "tenant" | "principal" | "tenant_month" | "admission",
  identity: string,
): string {
  if (!secret) throw new Error("rate_limit_key_unavailable");
  return createHmac("sha256", secret)
    .update(JSON.stringify([scope, identity]))
    .digest("hex");
}

class RateLimitDenied extends Error {
  constructor(
    readonly window: "minute" | "month",
    readonly retryAfterSeconds: number,
  ) {
    super("rate_limit_exceeded");
  }
}

export async function admitPersistentRateLimits(
  raw: Array<z.input<typeof limitInput>>,
  exec?: Executor,
  timestamp?: Date,
): Promise<AdmissionResult> {
  const limits = z.array(limitInput).min(1).max(4).parse(raw);
  const db = exec ?? getDb();
  const databaseNow = timestamp
    ? sql`${z.date().parse(timestamp).toISOString()}::timestamptz`
    : sql`transaction_timestamp()`;
  try {
    return await db.transaction(async (tx) => {
      for (const limit of limits) {
        const windowStart =
          limit.window === "month"
            ? sql`date_trunc('month', ${databaseNow} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
            : sql`date_trunc('minute', ${databaseNow})`;
        const expiry =
          limit.window === "month"
            ? sql`(${windowStart} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC' + interval '3 minutes'`
            : sql`${windowStart} + interval '3 minutes'`;
        const result = await tx.execute<{ hits: number }>(sql`
          INSERT INTO subkit.http_rate_limit_buckets (bucket_key, window_started_at, hits, expires_at)
          VALUES (${limit.bucket_key}, ${windowStart}, 1, ${expiry})
          ON CONFLICT (bucket_key, window_started_at)
          DO UPDATE SET hits = subkit.http_rate_limit_buckets.hits + 1
          WHERE subkit.http_rate_limit_buckets.hits < ${limit.max}
          RETURNING hits
        `);
        if (result.rows.length === 0) {
          const end =
            limit.window === "month"
              ? sql`(${windowStart} AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'`
              : sql`${windowStart} + interval '1 minute'`;
          const retry = await tx.execute<{ retry_after_seconds: number }>(
            sql`SELECT greatest(1, ceil(extract(epoch FROM (${end} - ${databaseNow}))))::integer AS retry_after_seconds`,
          );
          throw new RateLimitDenied(limit.window, retry.rows[0]?.retry_after_seconds ?? 60);
        }
        if (result.rows[0]?.hits === 1) {
          await tx.execute(sql`
            DELETE FROM subkit.http_rate_limit_buckets
            WHERE (bucket_key, window_started_at) IN (
              SELECT bucket_key, window_started_at FROM subkit.http_rate_limit_buckets
              WHERE expires_at < ${databaseNow} LIMIT 1000
            )
          `);
        }
      }
      return { allowed: true };
    });
  } catch (error) {
    if (error instanceof RateLimitDenied)
      return { allowed: false, window: error.window, retry_after_seconds: error.retryAfterSeconds };
    throw error;
  }
}

export async function consumePersistentRateLimits(
  raw: Array<z.input<typeof limitInput>>,
  exec?: Executor,
  timestamp?: Date,
): Promise<boolean> {
  return (await admitPersistentRateLimits(raw, exec, timestamp)).allowed;
}
