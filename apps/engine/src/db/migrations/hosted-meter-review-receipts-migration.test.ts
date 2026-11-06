import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedConversation } from "../../test-helpers/seed.ts";
import { runMigrations, SQUASHED_CHAIN_HEAD_TAG } from "../migrate.ts";
import { hostedTenantUsage, workflowReviewReceipts } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const nextUuid = createDeterministicUuidFactory(0x7e01);

const TAG = "0001_hosted_meter_workflow_review_receipts";
const RESOURCE = "workflow_review_receipts";
const squashedTags = Array.from(
  { length: 151 },
  (_, idx) => `${String(idx).padStart(4, "0")}_squashed_${idx}`,
).concat(SQUASHED_CHAIN_HEAD_TAG);
const snapshots = [{ definition: { name: "upgrade-a" } }, { note: "z".repeat(300) }];

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("hosted-meter-review-receipts-migration");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function meterMigration(): EmbeddedMigration {
  const migration = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!migration) throw new Error(`${TAG} missing from the embedded bundle`);
  return migration;
}

async function selfServiceConversation(subject: string) {
  const { tenant } = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    ctx.db,
  );
  const conversation = await seedConversation(ctx.db, { id: nextUuid(), tenant_id: tenant.id });
  return { tenantId: tenant.id, conversationId: conversation.id };
}

async function insertReceipts(tenantId: string, conversationId: string) {
  await ctx.db.insert(workflowReviewReceipts).values(
    snapshots.map((snapshot) => ({
      tenant_id: tenantId,
      conversation_id: conversationId,
      prepared_by: nextUuid(),
      session_id: nextUuid(),
      snapshot,
      snapshot_digest: "b".repeat(64),
      expires_at: sql`clock_timestamp() + interval '10 minutes'`,
    })),
  );
}

async function usage(tenantId: string) {
  const [row] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!row) throw new Error("hosted usage row missing");
  const counts = row.resource_counts as Record<string, string>;
  return { bytes: row.logical_bytes, count: counts[RESOURCE] ?? null };
}

async function meterTriggerCount(): Promise<number> {
  const result = (await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgrelid = 'subkit.workflow_review_receipts'::regclass
          AND tgname = 'hosted_meter_workflow_review_receipts' AND NOT tgisinternal`,
  )) as unknown as { rows: Array<{ n: number }> };
  return result.rows[0]?.n ?? 0;
}

async function restoreSquashedChainHistory(): Promise<void> {
  await ctx.db.execute(sql`DELETE FROM "subkit"."__drizzle_migrations"`);
  for (const tag of squashedTags)
    await ctx.db.execute(
      sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag) VALUES (md5(${tag}), 0, ${tag})`,
    );
}

describe(TAG, () => {
  test("a fresh database carries the meter trigger", async () => {
    expect(meterMigration().idx).toBe(1);
    expect(await meterTriggerCount()).toBe(1);
  });

  test("an installation upgraded from the squashed chain counts existing receipts exactly once", async () => {
    await ctx.db.execute(
      sql`DROP TRIGGER hosted_meter_workflow_review_receipts ON subkit.workflow_review_receipts`,
    );
    await ctx.db.execute(sql`DROP FUNCTION subkit.hosted_meter_workflow_review_receipts()`);
    const legacy = await selfServiceConversation("receipts-upgrade-legacy");
    const legacyBefore = await usage(legacy.tenantId);
    await insertReceipts(legacy.tenantId, legacy.conversationId);
    expect(await usage(legacy.tenantId)).toEqual(legacyBefore);
    expect(legacyBefore.count).toBeNull();

    await restoreSquashedChainHistory();
    expect(await runMigrations(ctx.db)).toEqual({
      applied: 1,
      skipped: 0,
      hash_drift_backfilled: 1,
      total: EMBEDDED_MIGRATIONS.length,
    });
    expect(await meterTriggerCount()).toBe(1);
    const legacyAfter = await usage(legacy.tenantId);
    expect(legacyAfter.count).toBe(String(snapshots.length));

    const live = await selfServiceConversation("receipts-upgrade-live");
    const liveBefore = await usage(live.tenantId);
    await insertReceipts(live.tenantId, live.conversationId);
    const liveAfter = await usage(live.tenantId);
    expect(liveAfter.count).toBe(String(snapshots.length));
    expect(legacyAfter.bytes - legacyBefore.bytes).toBe(liveAfter.bytes - liveBefore.bytes);
    expect(legacyAfter.bytes).toBeGreaterThan(legacyBefore.bytes);
  });

  test("rerunning the runner or the raw statements leaves usage unchanged", async () => {
    const tenants = (
      await ctx.db.select({ id: hostedTenantUsage.tenant_id }).from(hostedTenantUsage)
    ).map((row) => row.id);
    const before = await Promise.all(tenants.map(usage));
    expect(await runMigrations(ctx.db)).toEqual({
      applied: 0,
      skipped: EMBEDDED_MIGRATIONS.length,
      hash_drift_backfilled: 0,
      total: EMBEDDED_MIGRATIONS.length,
    });
    await ctx.db.transaction(async (tx) => {
      for (const statement of meterMigration().statements) await tx.execute(sql.raw(statement));
    });
    expect(await meterTriggerCount()).toBe(1);
    expect(await Promise.all(tenants.map(usage))).toEqual(before);
  });
});
