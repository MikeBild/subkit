import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { generateAccessToken } from "../../auth/oauth/tokens.ts";
import { loadDraft } from "../../conversations/draft.ts";
import {
  apiKeys,
  intakeItems,
  knowledgeSources,
  mcpOauthAccessTokens,
  mcpOauthClients,
  skills,
  users,
} from "../../db/schema/index.ts";
import { generateKey } from "../../identity/api-key.ts";
import { createSessionIntakeItem } from "../../knowledge/index.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createSkill } from "../../skills/service.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

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

function browserHeaders(userId: string): Promise<HeadersInit> {
  return browserSessionHeaders(ctx, userId);
}

async function browserRequest(
  path: string,
  body: unknown,
  browser: HeadersInit,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: browser,
    body: JSON.stringify(body),
  });
}

let roleCounter = 0;

async function browserPersona(permissions: string[]): Promise<HeadersInit> {
  roleCounter += 1;
  const role = await createRole(ctx.db, ctx.tenantId, `intake-confirm-${roleCounter}`);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `intake-confirm-${roleCounter}@test.local`,
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("missing persona user");
  await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  return browserHeaders(user.id);
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
    const admissionKey = await issueUserKey("intake-admission", [
      "intake:confirm",
      "knowledge:write",
    ]);
    for (const key of [collectorKey, intakeConfirmationOnly, knowledgeWriteOnly, admissionKey]) {
      const denied = await request(
        `/v1/intake/proposals/${proposal.id}/confirm`,
        "POST",
        confirmation,
        key,
      );
      expect(denied.status).toBe(403);
    }
    const keyAdmission = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      confirmation,
      admissionKey,
    );
    expect((await keyAdmission.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const confirmed = await browserRequest(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      confirmation,
      await browserPersona(["intake:confirm", "knowledge:write"]),
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()) as { status: string }).toMatchObject({ status: "confirmed" });
  });

  test("lets a signed-in writer permanently delete only a discarded intake item", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-0000000000d1",
      category: "intake-test",
      title: "Discarded HTTP fixture",
      source_url: "https://example.test/discarded-http-fixture",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "This raw fixture must disappear after permanent deletion.",
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string; version: number };
    const discarded = await request(`/v1/intake/items/${item.id}`, "PATCH", {
      expected_version: item.version,
      state: "discarded",
    });
    expect(discarded.status).toBe(200);
    const discardedItem = (await discarded.json()) as { version: number };

    const keyDeletion = await request(`/v1/intake/items/${item.id}`, "DELETE", {
      expected_version: discardedItem.version,
    });
    expect(keyDeletion.status).toBe(403);
    expect((await keyDeletion.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const browser = await browserPersona(["intake:write"]);
    const deleted = await fetch(`${ctx.baseUrl}/v1/intake/items/${item.id}`, {
      method: "DELETE",
      headers: browser,
      body: JSON.stringify({ expected_version: discardedItem.version }),
    });
    expect(deleted.status).toBe(204);
    expect((await request(`/v1/intake/items/${item.id}`, "GET")).status).toBe(404);
    const listed = await request("/v1/intake/items", "GET");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { items: Array<{ id: string }> }).items).not.toContainEqual(
      expect.objectContaining({ id: item.id }),
    );
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

    const confirmed = await browserRequest(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      { expected_revision: proposal.current_revision, digest: proposal.revision.digest },
      await browserHeaders(ctx.userId),
    );
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

  test("collects a note without a source address and filters the list by origin", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000090",
      category: "notes",
      title: "Note without address",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A thought worth reviewing later.",
    });
    expect(collected.status).toBe(201);
    const note = (await collected.json()) as {
      id: string;
      state: string;
      original_snapshot: Record<string, unknown>;
    };
    expect(note.state).toBe("collected");
    expect(note.original_snapshot.origin).toBe("note");
    expect(note.original_snapshot).not.toHaveProperty("source_url");

    const pretendingCapture = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000091",
      title: "Note claiming a captured origin",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "No address, but a capture origin.",
      original_snapshot: { origin: "capture" },
    });
    expect(pretendingCapture.status).toBe(400);

    const listed = async (origin: string) => {
      const response = await request(`/v1/intake/items?category=notes&origin=${origin}`, "GET");
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    };
    expect(await listed("note")).toContain(note.id);
    expect(await listed("session")).not.toContain(note.id);
    expect(await listed("capture")).not.toContain(note.id);
    expect((await request("/v1/intake/items?origin=llm", "GET")).status).toBe(400);
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

  test("rejects confirmation over MCP OAuth and token exchange", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000031",
      category: "recording",
      title: "Delegated confirmation clip",
      source_url: "https://example.test/delegated",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A delegated credential must not admit this.",
    });
    const item = (await collected.json()) as { id: string };
    const proposed = await request("/v1/intake/proposals", "POST", {
      item_ids: [item.id],
      title: "Delegated guidance",
      body: "Only a signed-in person admits this.",
      target: { name: "Delegated recording knowledge" },
    });
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };
    const body = { expected_revision: proposal.current_revision, digest: proposal.revision.digest };

    const clientId = "intake-confirm-delegated-client";
    await ctx.db.insert(mcpOauthClients).values({ client_id: clientId, scope: "*" });
    const oauthToken = generateAccessToken();
    await ctx.db.insert(mcpOauthAccessTokens).values({
      tenant_id: ctx.tenantId,
      client_id: clientId,
      user_id: ctx.userId,
      prefix: oauthToken.prefix,
      token_sha256: oauthToken.hash,
      scope: "*",
      resource: `${ctx.baseUrl}/mcp`,
      expires_at: new Date(getTestNow() + 60_000),
    });
    const overMcp = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      oauthToken.plaintext,
    );
    expect(overMcp.status).toBe(403);

    const exchangeKey = generateKey();
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: exchangeKey.prefix,
      token_sha256: exchangeKey.hash,
      scopes: ["*"],
    });
    const exchanged = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: exchangeKey.plaintext,
        subject_token_type: "urn:subkit:params:oauth:token-type:api-key",
      }).toString(),
    });
    expect(exchanged.status).toBe(200);
    const { access_token } = (await exchanged.json()) as { access_token: string };
    const overExchange = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      access_token,
    );
    expect(overExchange.status).toBe(403);
    expect((await overExchange.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const stored = await request(`/v1/intake/proposals/${proposal.id}`, "GET");
    expect(((await stored.json()) as { status: string }).status).toBe("draft");
  });

  test("an item read returns its latest session evidence, bounded and newest first", async () => {
    const first = await createSessionIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor: { kind: "user", id: ctx.userId },
        session: {
          agent: "claude-code",
          session_id: "evidence-read-1",
          repo: "example/repo",
          domains: [],
          evidence_excerpt: "user: first mention",
        },
        title: "Evidence read learning",
        body: "Repeated sessions add evidence.",
        captured_at: "2026-10-10T07:00:00.000Z",
      },
      ctx.db,
    );
    await createSessionIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor: { kind: "user", id: ctx.userId },
        session: {
          agent: "codex",
          session_id: "evidence-read-2",
          repo: null,
          domains: [],
          evidence_excerpt: "user: second mention",
        },
        title: "Evidence read learning",
        body: "Repeated sessions add evidence.",
        captured_at: "2026-10-11T07:00:00.000Z",
      },
      ctx.db,
    );
    const read = await request(`/v1/intake/items/${first.item.id}`, "GET");
    expect(read.status).toBe(200);
    const detail = (await read.json()) as {
      version: number;
      evidence_total: number;
      evidence: Array<{ agent: string; session_id: string; repo: string | null; excerpt: string }>;
    };
    expect(detail.version).toBe(1);
    expect(detail.evidence_total).toBe(2);
    expect(
      detail.evidence.map(({ agent, session_id, repo, excerpt }) => ({
        agent,
        session_id,
        repo,
        excerpt,
      })),
    ).toEqual([
      {
        agent: "codex",
        session_id: "evidence-read-2",
        repo: null,
        excerpt: "user: second mention",
      },
      {
        agent: "claude-code",
        session_id: "evidence-read-1",
        repo: "example/repo",
        excerpt: "user: first mention",
      },
    ]);
  });

  test("keeps existing knowledge routes available", async () => {
    const response = await request("/v1/knowledge-sources", "GET");
    expect(response.status).toBe(200);
  });

  test("uses an actor default shared category and lets the actor replace it", async () => {
    const initial = await request("/v1/intake/default-category", "GET");
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { category: string; can_collect: boolean }).toEqual({
      category: "inbox",
      can_collect: true,
    });

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

  test("requires the target-specific permissions from a browser session for each confirmation", async () => {
    const sessionItem = async (title: string) =>
      (
        await createSessionIntakeItem(
          {
            tenant_id: ctx.tenantId,
            actor: { kind: "user", id: ctx.userId },
            title,
            body: `${title} body`,
            captured_at: "2026-10-10T07:00:00.000Z",
            session: {
              agent: "claude-code",
              session_id: `http-session-${title}`,
              repo: null,
              domains: [],
              evidence_excerpt: `${title} evidence`,
            },
          },
          ctx.db,
        )
      ).item;
    const propose = async (title: string, target: unknown) => {
      const item = await sessionItem(title);
      const response = await request("/v1/intake/proposals", "POST", {
        item_ids: [item.id],
        title,
        body: `${title} proposal body`,
        target,
      });
      expect(response.status).toBe(201);
      const proposal = (await response.json()) as {
        id: string;
        current_revision: number;
        revision: { digest: string };
      };
      return {
        path: `/v1/intake/proposals/${proposal.id}/confirm`,
        body: { expected_revision: proposal.current_revision, digest: proposal.revision.digest },
      };
    };
    const superseded = await createSkill(
      {
        tenant_id: ctx.tenantId,
        input: { scope: "global", title: "Superseded http skill", body: "Old guidance." },
      },
      ctx.db,
    );
    const newSkill = (
      title: string,
      supersedes: { skill_id: string; expected_version: number }[] = [],
    ) => ({
      skill: {
        new: { title, scope: "global", tags: [], category: "jira" },
        supersedes,
      },
    });

    const confirmOnly = await browserPersona(["intake:confirm"]);
    const knowledgeWriter = await browserPersona(["intake:confirm", "knowledge:write"]);
    const skillWriter = await browserPersona(["intake:confirm", "skill:write", "skill:activate"]);
    const skillArchiver = await browserPersona([
      "intake:confirm",
      "skill:write",
      "skill:activate",
      "skill:archive",
    ]);

    const knowledge = await propose("Http knowledge target", { name: "Http knowledge target" });
    for (const persona of [confirmOnly, skillWriter])
      expect((await browserRequest(knowledge.path, knowledge.body, persona)).status).toBe(403);
    expect((await browserRequest(knowledge.path, knowledge.body, knowledgeWriter)).status).toBe(
      200,
    );

    const skill = await propose("Http skill target", newSkill("Http skill target"));
    for (const persona of [confirmOnly, knowledgeWriter])
      expect((await browserRequest(skill.path, skill.body, persona)).status).toBe(403);
    const admitted = await browserRequest(skill.path, skill.body, skillWriter);
    expect(admitted.status).toBe(200);
    const admittedBody = (await admitted.json()) as {
      confirmed_target_kind: string;
      confirmed_target_id: string;
    };
    expect(admittedBody.confirmed_target_kind).toBe("skill");
    const repeated = await browserRequest(skill.path, skill.body, skillWriter);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { confirmed_target_id: string }).confirmed_target_id).toBe(
      admittedBody.confirmed_target_id,
    );
    expect(
      await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Http skill target"))),
    ).toHaveLength(1);

    const replacing = await propose(
      "Http replacing skill",
      newSkill("Http replacing skill", [
        { skill_id: superseded.id, expected_version: superseded.version },
      ]),
    );
    expect((await browserRequest(replacing.path, replacing.body, skillWriter)).status).toBe(403);
    expect((await browserRequest(replacing.path, replacing.body, skillArchiver)).status).toBe(200);

    const stale = await propose("Http stale skill", newSkill("Http stale skill"));
    expect(
      (
        await browserRequest(
          stale.path,
          { ...stale.body, expected_revision: stale.body.expected_revision + 1 },
          skillArchiver,
        )
      ).status,
    ).toBe(409);
  });
});
