import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversationMessages, conversations } from "../../db/schema/conversations.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { backfillEmbeddings } from "../../embeddings/backfill.ts";
import { suggestConversationsByTopic } from "../topic-routing.ts";

const skip = process.env.REQUIRES_PG === "0" || process.env.RUN_EMBEDDING_E2E !== "1";

let testDb: TestDb;
let tenantId: string;
const ownerId = "00000000-0000-0000-0000-0000000000aa";
const otherOwnerId = "00000000-0000-0000-0000-0000000000bb";
const ids: Record<string, string> = {};

async function seedConversation(owner: string, firstUserMessage: string): Promise<string> {
  const [conv] = await testDb.db
    .insert(conversations)
    .values({ tenant_id: tenantId, owner_id: owner, status: "active" })
    .returning({ id: conversations.id });
  await testDb.db.insert(conversationMessages).values({
    tenant_id: tenantId,
    conversation_id: conv!.id,
    role: "user",
    content: firstUserMessage,
  });
  return conv!.id;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("topic-route");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "topic-route", display_name: "Topic Route" })
    .returning();
  tenantId = tenant!.id;
  ids.stripe = await seedConversation(
    ownerId,
    "Set up Stripe to take online card payments from customers",
  );
  ids.github = await seedConversation(
    ownerId,
    "Weekly report of merged pull requests across our GitHub repos",
  );
  ids.jira = await seedConversation(ownerId, "Create Jira tickets from inbound support emails");
  ids.otherStripe = await seedConversation(otherOwnerId, "Stripe refunds and chargebacks workflow");
  await backfillEmbeddings({ tenant_id: tenantId }, testDb.db);
}, 120_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("conversations/topic-routing", () => {
  test("routes a related prompt to the right conversation", async () => {
    const out = await suggestConversationsByTopic(
      {
        tenant_id: tenantId,
        owner_id: ownerId,
        message: "Continue setting up card payments with Stripe",
      },
      testDb.db,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.conversation_id).toBe(ids.stripe!);
  });

  test("German prompt routes to the English GitHub conversation (cross-lang)", async () => {
    const out = await suggestConversationsByTopic(
      {
        tenant_id: tenantId,
        owner_id: ownerId,
        message: "Weiter mit dem wöchentlichen GitHub Pull-Request-Report",
      },
      testDb.db,
    );
    expect(out[0]?.conversation_id).toBe(ids.github!);
  });

  test("an unrelated prompt abstains (no suggestion → start fresh)", async () => {
    const out = await suggestConversationsByTopic(
      {
        tenant_id: tenantId,
        owner_id: ownerId,
        message: "Help me write a SQL migration for a new users table",
      },
      testDb.db,
    );
    expect(out).toEqual([]);
  });

  test("never suggests another user's conversation", async () => {
    const out = await suggestConversationsByTopic(
      { tenant_id: tenantId, owner_id: ownerId, message: "Stripe refunds and chargebacks" },
      testDb.db,
    );
    expect(out.every((s) => s.conversation_id !== ids.otherStripe)).toBe(true);
  });
});
