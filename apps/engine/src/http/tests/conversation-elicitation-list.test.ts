// HTTP-layer coverage for `pending_elicitation_*` on `GET /v1/conversations`
// (the list route's `ConversationListItem` / `ConversationSchema` fields).
//
// `listConversations` (conversations/service/lifecycle.ts) used to fill
// `pending_elicitation_expires_at` with a `min(expires_at)` GROUP BY over
// pending `conversation_elicitations`. It is now a
// `selectDistinctOn([conversation_id])` ordered by
// `(conversation_id, expires_at ASC)` that additionally returns `summary`
// and `tool_name`, populating `pending_elicitation_summary` and
// `pending_elicitation_tool`.
//
// The tests below pin:
//   - a single pending elicitation surfaces its summary + tool on the list row
//   - TWO pending elicitations on one conversation: the row returned is the
//     one that expires FIRST, not an arbitrary one a naive rewrite might pick
//   - no pending elicitation → null for all three fields
//   - a resolved (non-pending) elicitation contributes nothing
//   - a long summary is clipped through `truncateExcerpt`, same as the
//     message-excerpt fields
//   - cross-tenant isolation and the deadline field itself, which a prior
//     `min(expires_at)` implementation already covered and must keep passing

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
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
    // The decisive case for `distinct on (conversation_id) order by
    // (conversation_id, expires_at asc)`: a naive rewrite (e.g. distinct on
    // without the expires_at ordering, or a plain limit-1) could return
    // whichever row the planner happens to visit first. Two rows that
    // differ in BOTH expires_at and summary make a wrong pick unambiguous.
    const id = await seedConversation("two-pending");
    const base = getTestNow();
    const soonerExpiry = new Date(base + 30_000);
    // Insert the LATER-expiring row first so insertion order cannot be
    // mistaken for the correct ordering signal.
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

  test("a very long summary is clipped through truncateExcerpt", async () => {
    const id = await seedConversation("long-summary");
    const longSummary = "x".repeat(500);
    await seedElicitation({
      conversation_id: id,
      tenant_id: srv.tenantId,
      expires_at: new Date(getTestNow() + 60_000),
      summary: longSummary,
      tool_name: "ask_user_form",
    });

    const item = await fetchItem(id);
    expect(item.pending_elicitation_summary).not.toBeNull();
    const clipped = item.pending_elicitation_summary as string;
    expect(clipped.length).toBeLessThan(longSummary.length);
    expect(clipped.endsWith("…")).toBe(true);
  });

  test("cross-tenant: a pending elicitation on another tenant's conversation never surfaces", async () => {
    const [otherTenant] = await srv.db
      .insert(tenants)
      .values({ slug: "t-conv-elicit-other", display_name: "other" })
      .returning();
    if (!otherTenant) throw new Error("seed other tenant failed");
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

    // The foreign conversation must not even be visible to this tenant's
    // credential — the list is tenant-scoped end to end.
    const res = await fetch(`${srv.baseUrl}/v1/conversations?limit=200`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.find((i) => i.id === otherConv.id)).toBeUndefined();

    // And the row in the database really did carry the foreign tenant_id —
    // proving this is a tenant-scope assertion, not an accidental miss.
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
