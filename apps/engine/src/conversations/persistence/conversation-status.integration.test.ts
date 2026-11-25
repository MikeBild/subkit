import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { CONVERSATION_TRANSITIONS } from "../core/conversation-status.ts";
import { cancelConversation } from "../service/lifecycle.ts";
import type { ConversationStatus } from "../types.ts";
import { transitionConversation } from "./conversation-status.ts";

const nextUuid = createDeterministicUuidFactory(4801);

const STATUSES = Object.keys(CONVERSATION_TRANSITIONS) as ConversationStatus[];

let ctx: TestDb;
let tenant_id: string;
let other_tenant_id: string;

async function conversationIn(tenant: string, status: ConversationStatus): Promise<string> {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenant, status })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation was not created");
  return row.id;
}

async function statusOf(tenant: string, id: string): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ status: conversations.status })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant), eq(conversations.id, id)));
  return row?.status;
}

beforeAll(async () => {
  ctx = await createTestDb("conversation_status_writer");
  const created = await ctx.db
    .insert(tenants)
    .values([
      { slug: "status-writer", display_name: "Status writer" },
      { slug: "status-writer-other", display_name: "Status writer other" },
    ])
    .returning({ id: tenants.id });
  const [first, second] = created;
  if (!first || !second) throw new Error("tenants were not created");
  tenant_id = first.id;
  other_tenant_id = second.id;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("transitionConversation", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const allowed = CONVERSATION_TRANSITIONS[from].includes(to);
      test(`${from} to ${to} is ${allowed ? "written" : "refused"}`, async () => {
        const id = await conversationIn(tenant_id, from);
        const row = await transitionConversation(ctx.db, { tenant_id, conversation_id: id, to });
        expect(row?.status ?? null).toBe(allowed ? to : null);
        expect(await statusOf(tenant_id, id)).toBe(allowed ? to : from);
      });
    }
  }

  test("an abandoned conversation is not brought back by a resolved question", async () => {
    const id = await conversationIn(tenant_id, "abandoned");
    const row = await transitionConversation(ctx.db, {
      tenant_id,
      conversation_id: id,
      to: "active",
      set: { updated_at: new Date() },
    });
    expect(row).toBeNull();
    expect(await statusOf(tenant_id, id)).toBe("abandoned");
  });

  test("a narrowed source leaves other states alone", async () => {
    const id = await conversationIn(tenant_id, "committed");
    const row = await transitionConversation(ctx.db, {
      tenant_id,
      conversation_id: id,
      to: "active",
      from: ["awaiting_input"],
    });
    expect(row).toBeNull();
    expect(await statusOf(tenant_id, id)).toBe("committed");
  });

  test("another tenant's conversation is never written", async () => {
    const id = await conversationIn(other_tenant_id, "active");
    const row = await transitionConversation(ctx.db, {
      tenant_id,
      conversation_id: id,
      to: "awaiting_input",
    });
    expect(row).toBeNull();
    expect(await statusOf(other_tenant_id, id)).toBe("active");
  });

  test("cancelling an abandoned conversation again still answers with it", async () => {
    const id = await conversationIn(tenant_id, "active");
    const first = await cancelConversation(tenant_id, id, null, ctx.db, "system");
    const second = await cancelConversation(tenant_id, id, null, ctx.db, "system");
    expect(first?.status).toBe("abandoned");
    expect(second?.status).toBe("abandoned");
    expect(await cancelConversation(tenant_id, nextUuid(), null, ctx.db, "system")).toBe(null);
  });
});
