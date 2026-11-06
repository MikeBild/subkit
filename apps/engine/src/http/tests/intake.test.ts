import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { loadDraft } from "../../conversations/draft.ts";
import { intakeItems } from "../../db/schema/index.ts";
import {
  browserHeaders,
  browserPersona,
  browserRequest,
  ctx,
  issueUserKey,
  request,
  setupIntakeHttp,
} from "./intake-fixtures.ts";

setupIntakeHttp();

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
});
