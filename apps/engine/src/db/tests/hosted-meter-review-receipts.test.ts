import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedConversation } from "../../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { hostedQuotaError } from "../hosted-quota-errors.ts";
import { conversations, hostedTenantUsage, workflowReviewReceipts } from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0x7e02);

const RESOURCE = "workflow_review_receipts";
const DIGEST = "a".repeat(64);

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("hosted-meter-review-receipts");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

beforeEach(async () => {
  await policy("50000000", 1000);
});

async function policy(bytes: string, rows: number) {
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${bytes}::text)),'{storage,hosted,retained_rows_per_resource}',to_jsonb(${rows}::int)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
}

async function selfServiceTenant(subject: string) {
  const { tenant } = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  return tenant.id;
}

async function selfServiceConversation(subject: string) {
  const tenantId = await selfServiceTenant(subject);
  const conversationId = await conversationFor(tenantId);
  return { tenantId, conversationId };
}

async function conversationFor(tenantId: string) {
  const conversation = await seedConversation(ctx.db, { id: nextUuid(), tenant_id: tenantId });
  return conversation.id;
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

function receipt(tenantId: string, conversationId: string, snapshot: Record<string, unknown>) {
  return {
    tenant_id: tenantId,
    conversation_id: conversationId,
    prepared_by: nextUuid(),
    session_id: nextUuid(),
    snapshot,
    snapshot_digest: DIGEST,
    expires_at: sql`clock_timestamp() + interval '10 minutes'`,
  };
}

async function jsonbBytes(snapshot: Record<string, unknown>) {
  const result = (await ctx.db.execute(
    sql`SELECT octet_length(convert_to(${JSON.stringify(snapshot)}::jsonb::text,'UTF8'))::int AS n`,
  )) as unknown as { rows: Array<{ n: number }> };
  return result.rows[0]?.n ?? 0;
}

async function rejection(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (error) {
    return hostedQuotaError(error)?.code;
  }
  return null;
}

describe("hosted metering of workflow review receipts", () => {
  test("insert, completion and deletion move the tenant usage by the receipt content", async () => {
    const { tenantId, conversationId } = await selfServiceConversation("review-meter-life");
    const snapshot = { definition: { name: "review-meter" }, note: "x".repeat(120) };
    const pendingBytes =
      BigInt(await jsonbBytes(snapshot)) + BigInt(DIGEST.length) + BigInt("pending".length);
    const before = await usage(tenantId);
    const [row] = await ctx.db
      .insert(workflowReviewReceipts)
      .values(receipt(tenantId, conversationId, snapshot))
      .returning();
    const inserted = await usage(tenantId);
    expect(inserted.count).toBe(before.count + 1);
    expect(inserted.bytes - before.bytes).toBe(pendingBytes);

    await ctx.db
      .update(workflowReviewReceipts)
      .set({ status: "completed", completed_at: new Date(getTestNow()) })
      .where(eq(workflowReviewReceipts.id, row!.id));
    const completed = await usage(tenantId);
    expect(completed.count).toBe(inserted.count);
    expect(completed.bytes - inserted.bytes).toBe(BigInt("completed".length - "pending".length));

    await ctx.db.delete(workflowReviewReceipts).where(eq(workflowReviewReceipts.id, row!.id));
    expect(await usage(tenantId)).toEqual(before);
  });

  test("deleting the conversation releases its receipts through the cascade", async () => {
    const tenantId = await selfServiceTenant("review-meter-cascade");
    const before = await usage(tenantId);
    const conversationId = await conversationFor(tenantId);
    await ctx.db
      .insert(workflowReviewReceipts)
      .values([
        receipt(tenantId, conversationId, { step: 1 }),
        receipt(tenantId, conversationId, { step: 2 }),
      ]);
    expect((await usage(tenantId)).count).toBe(before.count + 2);
    await ctx.db.delete(conversations).where(eq(conversations.id, conversationId));
    expect(await usage(tenantId)).toEqual(before);
  });

  test("a tenant at its row limit is refused with the standard quota error", async () => {
    const { tenantId, conversationId } = await selfServiceConversation("review-meter-rows");
    await ctx.db
      .insert(workflowReviewReceipts)
      .values(receipt(tenantId, conversationId, { step: 1 }));
    const atLimit = await usage(tenantId);
    await policy("50000000", atLimit.count);
    const code = await rejection(() =>
      ctx.db.insert(workflowReviewReceipts).values(receipt(tenantId, conversationId, { step: 2 })),
    );
    expect(code).toBe("hosted_resource_count_exhausted");
    expect(await usage(tenantId)).toEqual(atLimit);
    expect(
      await ctx.db
        .select({ id: workflowReviewReceipts.id })
        .from(workflowReviewReceipts)
        .where(eq(workflowReviewReceipts.tenant_id, tenantId)),
    ).toHaveLength(1);
  });

  test("a tenant at its byte limit is refused with the standard quota error", async () => {
    const { tenantId, conversationId } = await selfServiceConversation("review-meter-bytes");
    const before = await usage(tenantId);
    await policy((before.bytes + 100n).toString(), 1000);
    const code = await rejection(() =>
      ctx.db
        .insert(workflowReviewReceipts)
        .values(receipt(tenantId, conversationId, { note: "y".repeat(500) })),
    );
    expect(code).toBe("hosted_storage_quota_exhausted");
    expect(await usage(tenantId)).toEqual(before);
    expect(
      await ctx.db
        .select({ id: workflowReviewReceipts.id })
        .from(workflowReviewReceipts)
        .where(eq(workflowReviewReceipts.tenant_id, tenantId)),
    ).toHaveLength(0);
  });
});
