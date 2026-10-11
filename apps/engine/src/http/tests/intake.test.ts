import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { loadDraft } from "../../conversations/draft.ts";
import { apiKeys, intakeItems, knowledgeSources } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("intake-http");
});

afterAll(async () => {
  await ctx.cleanup();
});

function headers(key = ctx.apiKey): HeadersInit {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function request(
  path: string,
  method: string,
  body?: unknown,
  key?: string,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: headers(key),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function testKey(value: string): { plaintext: string; prefix: string; token_sha256: string } {
  return {
    plaintext: value,
    prefix: value.slice(0, 12),
    token_sha256: createHash("sha256").update(value).digest("hex"),
  };
}

async function issueUserKey(name: string, scopes: string[]): Promise<string> {
  const response = await request("/v1/identity/api-keys", "POST", {
    owner_kind: "user",
    owner_id: ctx.userId,
    name,
    scopes,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { plaintext_key: string }).plaintext_key;
}

describe("intake HTTP flow", () => {
  test("enforces read, collection, and knowledge admission as separate API-key personas", async () => {
    const readerKey = await issueUserKey("intake-reader", ["intake:read"]);
    const defaultCategory = await request(
      "/v1/intake/default-category",
      "GET",
      undefined,
      readerKey,
    );
    expect(defaultCategory.status).toBe(200);
    expect((await defaultCategory.json()) as { can_collect: boolean }).toMatchObject({
      can_collect: false,
    });
    expect((await request("/v1/intake/items", "GET", undefined, readerKey)).status).toBe(200);

    const beforeDeniedWrite = await ctx.db
      .select({ value: count() })
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctx.tenantId));
    const deniedCollection = await request(
      "/v1/intake/items",
      "POST",
      {
        client_request_id: "10000000-0000-4000-8000-000000000008",
        title: "Reader must not collect",
        source_url: "https://example.test/reader-denied",
        captured_at: "2026-10-10T07:00:00.000Z",
        body: "This item must not be persisted.",
      },
      readerKey,
    );
    expect(deniedCollection.status).toBe(403);
    const afterDeniedWrite = await ctx.db
      .select({ value: count() })
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctx.tenantId));
    expect(afterDeniedWrite[0]?.value).toBe(beforeDeniedWrite[0]?.value);

    const deniedKeyManagement = await request(
      "/v1/identity/api-keys",
      "POST",
      { owner_kind: "user", owner_id: ctx.userId, name: "escalation", scopes: ["*"] },
      readerKey,
    );
    expect(deniedKeyManagement.status).toBe(403);

    const collectorKey = await issueUserKey("intake-collector", ["intake:read", "intake:write"]);
    const collected = await request(
      "/v1/intake/items",
      "POST",
      {
        client_request_id: "10000000-0000-4000-8000-000000000009",
        category: "recording",
        title: "Collector persona item",
        source_url: "https://example.test/collector-persona",
        captured_at: "2026-10-10T07:00:00.000Z",
        body: "Collected content remains outside knowledge until confirmed.",
      },
      collectorKey,
    );
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string };
    const proposed = await request(
      "/v1/intake/proposals",
      "POST",
      {
        item_ids: [item.id],
        title: "Collector persona proposal",
        body: "A prepared proposal awaiting a person with admission rights.",
        target: { name: "Collector persona knowledge" },
      },
      collectorKey,
    );
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };
    const confirmation = {
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
    };

    const intakeConfirmationOnly = await issueUserKey("confirm-without-knowledge-write", [
      "intake:confirm",
    ]);
    const knowledgeWriteOnly = await issueUserKey("knowledge-write-without-confirm", [
      "knowledge:write",
    ]);
    for (const key of [collectorKey, intakeConfirmationOnly, knowledgeWriteOnly]) {
      const denied = await request(
        `/v1/intake/proposals/${proposal.id}/confirm`,
        "POST",
        confirmation,
        key,
      );
      expect(denied.status).toBe(403);
    }

    const admissionKey = await issueUserKey("intake-admission", [
      "intake:confirm",
      "knowledge:write",
    ]);
    const confirmed = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      confirmation,
      admissionKey,
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()) as { status: string }).toMatchObject({ status: "confirmed" });
  });

  test("collects, proposes, confirms, and then exposes only confirmed content to knowledge search", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000001",
      category: "recording",
      title: "Tape workflow insight",
      source_url: "https://example.test/tape",
      source_author: "Source author",
      published_at: "Autumn issue",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A four-track workflow keeps the original take beside the processed take.",
      note: "Could inform recording guidance.",
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as {
      id: string;
      version: number;
      original_snapshot: { body: string };
    };
    expect(item.original_snapshot.body).toContain("original take");

    const before = await request("/v1/knowledge-sources/search?q=four-track", "GET");
    expect(before.status).toBe(200);
    expect(((await before.json()) as { hits: unknown[] }).hits).toHaveLength(0);

    const proposed = await request("/v1/intake/proposals", "POST", {
      item_ids: [item.id],
      title: "Recording guidance",
      body: "Keep the original take beside the processed take when reviewing a recording.",
      target: { name: "Recording knowledge", category: "recording", tags: ["tape", "workflow"] },
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: {
        digest: string;
        items: Array<{ id: string }>;
        target: { name: string; category?: string; tags?: string[] };
      };
    };
    expect(proposal.revision.items.map((entry) => entry.id)).toEqual([item.id]);
    expect(proposal.revision.target).toEqual({
      name: "Recording knowledge",
      category: "recording",
      tags: ["tape", "workflow"],
    });

    const confirmed = await request(`/v1/intake/proposals/${proposal.id}/confirm`, "POST", {
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()) as { status: string }).toMatchObject({ status: "confirmed" });

    const after = await request(
      "/v1/knowledge-sources/search?q=original%20processed%20take",
      "GET",
    );
    expect(after.status).toBe(200);
    expect(
      ((await after.json()) as { hits: Array<{ snippet: string }> }).hits[0]?.snippet,
    ).toContain("original");
  });

  test("rejects category values outside the knowledge metadata contract", async () => {
    for (const category of ["Mission Reports", "mission_reports", "platform"]) {
      const response = await request("/v1/intake/proposals", "POST", {
        item_ids: ["10000000-0000-4000-8000-000000000099"],
        title: "Invalid category",
        body: "The request must fail before proposal creation.",
        target: { name: "Invalid category target", category },
      });
      expect(response.status).toBe(400);
    }
  });

  test("starts an HTTP selected review with persisted intake scope", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000003",
      category: "recording",
      title: "HTTP review clip",
      source_url: "https://example.test/http-review",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Review this source through the persisted conversation.",
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string };
    const started = await request("/v1/conversations", "POST", {
      initial_message: "Review the selected clip and propose useful knowledge.",
      intake_item_ids: [item.id],
    });
    expect(started.status).toBe(201);
    const body = (await started.json()) as { conversation: { id: string } };
    const draft = await loadDraft(ctx.tenantId, body.conversation.id, ctx.db);
    expect(draft.session).toMatchObject({
      intake_item_ids: [item.id],
      intake_review_locked: true,
    });

    const otherCollected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000007",
      category: "recording",
      title: "Unselected referenced clip",
      source_url: "https://example.test/unselected-reference",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "This must not expand an existing selected review.",
    });
    expect(otherCollected.status).toBe(201);
    const other = (await otherCollected.json()) as { id: string };
    const appended = await request(`/v1/conversations/${body.conversation.id}/messages`, "POST", {
      message: "Keep this @ reference visible without changing the selected review.",
      references: [{ type: "intake_item", id: other.id, label: "other-clip" }],
    });
    expect(appended.status).toBe(200);
    const afterAppend = await loadDraft(ctx.tenantId, body.conversation.id, ctx.db);
    expect(afterAppend.session).toMatchObject({
      intake_item_ids: [item.id],
      intake_review_locked: true,
    });
  });

  test("derives a locked selected review from an exact intake reference", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000006",
      category: "recording",
      title: "Referenced review clip",
      source_url: "https://example.test/referenced-review",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Only an explicit body read may expose this collected material.",
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string };
    const started = await request("/v1/conversations", "POST", {
      initial_message: "Review this @ reference.",
      references: [{ type: "intake_item", id: item.id, label: "clip-reference" }],
    });
    expect(started.status).toBe(201);
    const body = (await started.json()) as { conversation: { id: string } };
    const draft = await loadDraft(ctx.tenantId, body.conversation.id, ctx.db);
    expect(draft.session).toMatchObject({
      intake_item_ids: [item.id],
      intake_review_locked: true,
    });
  });

  test("rejects confirmation from a system principal and a key without admission rights", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000002",
      category: "recording",
      title: "Second recording insight",
      source_url: "https://example.test/second",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A source clip awaiting review.",
    });
    const item = (await collected.json()) as { id: string };
    const proposed = await request("/v1/intake/proposals", "POST", {
      item_ids: [item.id],
      title: "Second guidance",
      body: "Keep the source clip under review.",
      target: { name: "Second recording knowledge" },
    });
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };

    const systemKey = testKey("wf_live_system_confirmation_denied");
    const limitedKey = testKey("wf_live_limited_confirmation_denied");
    await ctx.db.insert(apiKeys).values([
      {
        tenant_id: ctx.tenantId,
        system_account_id: ctx.systemAccountId,
        prefix: systemKey.prefix,
        token_sha256: systemKey.token_sha256,
        scopes: ["*"],
      },
      {
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        prefix: limitedKey.prefix,
        token_sha256: limitedKey.token_sha256,
        scopes: ["intake:confirm"],
      },
    ]);

    const body = { expected_revision: proposal.current_revision, digest: proposal.revision.digest };
    const system = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      systemKey.plaintext,
    );
    expect(system.status).toBe(403);
    expect((await system.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const limited = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      limitedKey.plaintext,
    );
    expect(limited.status).toBe(403);
  });

  test("keeps existing knowledge routes available", async () => {
    const response = await request("/v1/knowledge-sources", "GET");
    expect(response.status).toBe(200);
  });

  test("uses an actor default shared category and lets the actor replace it", async () => {
    const initial = await request("/v1/intake/default-category", "GET");
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { category: string }).toEqual({ category: "inbox" });

    const updated = await request("/v1/intake/default-category", "PATCH", {
      category: "research",
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as { category: string }).toEqual({ category: "research" });

    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000004",
      title: "Default category clip",
      source_url: "https://example.test/default-category",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "The server resolves the caller's selected default.",
    });
    expect(collected.status).toBe(201);
    expect((await collected.json()) as { category: string }).toMatchObject({
      category: "research",
    });
  });

  test("requires intake write for a shared category rename only when intake is affected", async () => {
    const limitedKey = testKey("wf_live_category_rename_without_intake_write");
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: limitedKey.prefix,
      token_sha256: limitedKey.token_sha256,
      scopes: ["workflow:write", "connector:write", "knowledge:write", "skill:write", "file:write"],
    });

    await ctx.db.insert(knowledgeSources).values({
      tenant_id: ctx.tenantId,
      name: "Rename unaffected",
      slug: "rename-unaffected",
      category: "rename-unaffected",
      source_type: "text",
      source_uri: "https://example.test/unaffected",
      version: "initial",
    });
    const unaffected = await request(
      "/v1/categories/rename-unaffected/rename",
      "POST",
      {
        to: "rename-unaffected-next",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      limitedKey.plaintext,
    );
    expect(unaffected.status).toBe(200);

    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000005",
      category: "rename-restricted",
      title: "Rename protected clip",
      source_url: "https://example.test/rename-restricted",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A category rename that moves this clip requires intake write.",
    });
    expect(collected.status).toBe(201);

    const affected = await request(
      "/v1/categories/rename-restricted/rename",
      "POST",
      {
        to: "rename-restricted-next",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      limitedKey.plaintext,
    );
    expect(affected.status).toBe(403);
  });
});
