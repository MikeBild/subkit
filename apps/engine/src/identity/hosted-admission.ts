import { eq, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { admitPersistentRateLimits, rateLimitBucketKey } from "../db/rate-limits.ts";
import { tenants } from "../db/schema/index.ts";
import { SelfServiceIdentityError } from "./tenant-status.ts";

export async function admitHostedTenantCreation(exec: Executor): Promise<void> {
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    throw new SelfServiceIdentityError("registration_policy_unavailable");
  }
  const policy = config.auth.hosted.admission;
  if (
    !config.auth.session.secret ||
    policy.tenant_creations_per_minute <= 0 ||
    policy.retained_tenants <= 0
  )
    throw new SelfServiceIdentityError("registration_policy_unavailable");
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('hosted-tenant-admission', 0))`,
  );
  // tenant-filter:exempt — operator-wide stock admission counts every retained self-service tenant before a new tenant identity exists.
  const [count] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(tenants)
    .where(eq(tenants.origin, "self_service"));
  if ((count?.count ?? 0) >= policy.retained_tenants)
    throw new SelfServiceIdentityError("registration_policy_unavailable");
  const admitted = await admitPersistentRateLimits(
    [
      {
        bucket_key: rateLimitBucketKey(config.auth.session.secret, "admission", "tenant_creation"),
        max: policy.tenant_creations_per_minute,
      },
    ],
    exec,
  );
  if (!admitted.allowed) throw new SelfServiceIdentityError("registration_rate_limited");
}
