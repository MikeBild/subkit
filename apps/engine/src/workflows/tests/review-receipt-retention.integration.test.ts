import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { hostedTenantUsage, workflowReviewReceipts } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedConversation } from "../../test-helpers/seed.ts";
import { readDatabaseNow } from "../database-clock.ts";
import { purgeSpentReviewReceipts } from "../review-service.ts";

const nextUuid = createDeterministicUuidFactory(0x7e03);

const RESOURCE = "workflow_review_receipts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("review-receipt-retention");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

async function tenantWithConversation(subject: string) {
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

async function usage(tenantId: string) {
  const [row] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!row) throw new Error("hosted usage row missing");
  const counts = row.resource_counts as Record<string, string>;
  return { bytes: row.logical_bytes, count: Number(counts[RESOURCE] ?? 0) };
}

async function insertReceipt(tenantId: string, conversationId: string, expiresIn: string) {
  const [row] = await ctx.db
    .insert(workflowReviewReceipts)
    .values({
      tenant_id: tenantId,
      conversation_id: conversationId,
      prepared_by: nextUuid(),
      session_id: nextUuid(),
      snapshot: { note: "x".repeat(80) },
      snapshot_digest: "a".repeat(64),
      expires_at: sql`clock_timestamp() + ${expiresIn}::interval`,
    })
    .returning();
  if (!row) throw new Error("receipt insert failed");
  return row.id;
}

async function receiptIds(tenantId: string) {
  const rows = await ctx.db
    .select({ id: workflowReviewReceipts.id })
    .from(workflowReviewReceipts)
    .where(eq(workflowReviewReceipts.tenant_id, tenantId));
  return rows.map((row) => row.id).sort();
}

describe("review receipt retention", () => {
  test("finalized and expired receipts are purged and usage returns to baseline", async () => {
    const { tenantId, conversationId } = await tenantWithConversation("receipt-retention");
    const baseline = await usage(tenantId);
    const finalized = await insertReceipt(tenantId, conversationId, "10 minutes");
    const expired = await insertReceipt(tenantId, conversationId, "-1 minute");
    await ctx.db
      .update(workflowReviewReceipts)
      .set({ status: "completed", completed_at: new Date(getTestNow()) })
      .where(eq(workflowReviewReceipts.id, finalized));
    expect((await usage(tenantId)).count).toBe(baseline.count + 2);

    const kept = await ctx.db.transaction(async (tx) =>
      purgeSpentReviewReceipts(tx, tenantId, await readDatabaseNow(tx), finalized),
    );
    expect(kept).toBe(1);
    expect(await receiptIds(tenantId)).toEqual([finalized]);

    const purged = await ctx.db.transaction(async (tx) =>
      purgeSpentReviewReceipts(tx, tenantId, await readDatabaseNow(tx)),
    );
    expect(purged).toBe(1);
    expect(await receiptIds(tenantId)).toEqual([]);
    expect(expired).not.toBe(finalized);
    expect(await usage(tenantId)).toEqual(baseline);
  });

  test("open receipts and other tenants' receipts are kept", async () => {
    const own = await tenantWithConversation("receipt-retention-own");
    const other = await tenantWithConversation("receipt-retention-other");
    const open = await insertReceipt(own.tenantId, own.conversationId, "10 minutes");
    const foreign = await insertReceipt(other.tenantId, other.conversationId, "-1 minute");
    const purged = await ctx.db.transaction(async (tx) =>
      purgeSpentReviewReceipts(tx, own.tenantId, await readDatabaseNow(tx)),
    );
    expect(purged).toBe(0);
    expect(await receiptIds(own.tenantId)).toEqual([open]);
    expect(await receiptIds(other.tenantId)).toEqual([foreign]);
  });
});
