import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { userSetupPreferences } from "../db/schema/index.ts";

interface DigestOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

function ownRow(owner: DigestOwner) {
  return and(
    eq(userSetupPreferences.tenant_id, owner.tenant_id),
    eq(userSetupPreferences.user_id, owner.user_id),
  );
}

function markIs(value: Date | null) {
  return value === null
    ? sql`${userSetupPreferences.last_digest_at} IS NULL`
    : sql`date_trunc('milliseconds', ${userSetupPreferences.last_digest_at}) = ${value.toISOString()}::timestamptz`;
}

export async function claimDigest(
  db: Executor,
  owner: DigestOwner,
  previous: Date | null,
  at: Date,
): Promise<boolean> {
  const claimed = await db
    .update(userSetupPreferences)
    .set({ last_digest_at: at })
    .where(and(ownRow(owner), markIs(previous)))
    .returning({ user_id: userSetupPreferences.user_id });
  return claimed.length > 0;
}

export async function releaseDigest(
  db: Executor,
  owner: DigestOwner,
  previous: Date | null,
  at: Date,
): Promise<void> {
  await db
    .update(userSetupPreferences)
    .set({ last_digest_at: previous })
    .where(and(ownRow(owner), markIs(at)));
}
