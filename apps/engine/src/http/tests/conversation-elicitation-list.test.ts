import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PENDING_QUESTION_MAX } from "../../conversations/service/lifecycle.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

interface ListedConversation {
  id: string;
  pending_elicitation_expires_at: string | null;
  pending_elicitation_summary: string | null;
  pending_elicitation_tool: string | null;
}

interface ListBody {
  items: ListedConversation[];
  total: number;
}

let srv: HttpTestServer;

function headers(): Record<string, string> {
  return { authorization: `Bearer ${srv.apiKey}` };
}

async function seedConversation(title: string): Promise<string> {
  const [row] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "awaiting_input", title })
    .returning();
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedElicitation(opts: {
  conversation_id: string;
  tenant_id: string;
  expires_at: Date;
  summary: string;
  tool_name: string;
  status?: "pending" | "resolved" | "cancelled" | "timeout";
}): Promise<void> {
  await srv.db.insert(conversationElicitations).values({
    tenant_id: opts.tenant_id,
    conversation_id: opts.conversation_id,
    tool_name: opts.tool_name,
    summary: opts.summary,
    input: {},
    status: opts.status ?? "pending",
    expires_at: opts.expires_at,
  });
}

async function fetchItem(id: string): Promise<ListedConversation> {
  const res = await fetch(`${srv.baseUrl}/v1/conversations?limit=200`, { headers: headers() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as ListBody;
  const item = body.items.find((i) => i.id === id);
  if (!item) throw new Error(`conversation ${id} not found in list response`);
  return item;
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-elicit-list");
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/conversations — pending_elicitation_*", () => {
  test("one pending elicitation returns its summary and tool on the LIST row", async () => {
    const id = await seedConversation("single-pending");
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(getTestNow() + 60_000),
      summary: "Should I overwrite the existing schedule?",
      tool_name: "ask_user_confirm",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_summary).toBe("Should I overwrite the existing schedule?");
    expect(item.pending_elicitation_tool).toBe("ask_user_confirm");
    expect(item.pending_elicitation_expires_at).not.toBeNull();
  });

  test("two pending elicitations: the row returned is the one expiring FIRST", async () => {
    const id = await seedConversation("two-pending");
    const base = getTestNow();
    const soonerExpiry = new Date(base + 30_000);
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(base + 600_000),
      summary: "later-expiring: pick the wrong branch and this shows up",
      tool_name: "ask_user_form",
    });
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: soonerExpiry,
      summary: "sooner-expiring: this one actually bites first",
      tool_name: "ask_user_confirm",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_summary).toBe("sooner-expiring: this one actually bites first");
    expect(item.pending_elicitation_tool).toBe("ask_user_confirm");
    expect(item.pending_elicitation_expires_at).toBe(soonerExpiry.toISOString());
  });

  test("no pending elicitation → null for all three fields", async () => {
    const id = await seedConversation("no-pending");
    const item = await fetchItem(id);
    expect(item.pending_elicitation_expires_at).toBeNull();
    expect(item.pending_elicitation_summary).toBeNull();
    expect(item.pending_elicitation_tool).toBeNull();
  });

  test("a resolved (non-pending) elicitation does not contribute", async () => {
    const id = await seedConversation("resolved-only");
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(getTestNow() + 60_000),
      summary: "already answered, should not surface",
      tool_name: "ask_user_confirm",
      status: "resolved",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_expires_at).toBeNull();
    expect(item.pending_elicitation_summary).toBeNull();
    expect(item.pending_elicitation_tool).toBeNull();
  });

  test("a long question arrives whole, not as an excerpt of itself", async () => {
    const id = await seedConversation("long-summary");
    const question = `Should I overwrite the existing schedule? ${"Details follow. ".repeat(30)}`;
    expect(question.length).toBeGreaterThan(400);
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(getTestNow() + 60_000),
      summary: question,
      tool_name: "ask_user_form",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_summary).toBe(question.trim());
  });

  test("a runaway question still meets the payload guard", async () => {
    const id = await seedConversation("runaway-summary");
    const runaway = "x".repeat(PENDING_QUESTION_MAX + 500);
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(getTestNow() + 60_000),
      summary: runaway,
      tool_name: "ask_user_form",
    });

    const clipped = (await fetchItem(id)).pending_elicitation_summary as string;
    expect(clipped).not.toBeNull();
    expect(clipped.length).toBeLessThanOrEqual(PENDING_QUESTION_MAX);
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("cross-tenant: a pending elicitation on another tenant's conversation never surfaces", async () => {
    const otherTenant = await seedTenant(srv.db, {
      slug: "t-conv-elicit-other",
      display_name: "other",
    });
    const [otherConv] = await srv.db
      .insert(conversations)
      .values({ tenant_id: otherTenant.id, status: "awaiting_input", title: "foreign" })
      .returning();
    if (!otherConv) throw new Error("seed other conversation failed");
    await seedElicitation({
      conversation_id: otherConv.id,
      tenant_id: otherTenant.id,
      expires_at: new Date(getTestNow() + 60_000),
      summary: "belongs to a different tenant",
      tool_name: "ask_user_confirm",
    });

    const res = await fetch(`${srv.baseUrl}/v1/conversations?limit=200`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.find((i) => i.id === otherConv.id)).toBeUndefined();

    const [row] = await srv.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, otherConv.id));
    expect(row?.tenant_id).toBe(otherTenant.id);
  });

  test("pending_elicitation_expires_at reflects the deadline (regression: prior min(expires_at) behavior)", async () => {
    const id = await seedConversation("deadline-only");
    const deadline = new Date(getTestNow() + 120_000);
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: deadline,
      summary: "deadline probe",
      tool_name: "ask_user_confirm",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_expires_at).toBe(deadline.toISOString());
  });
});
