// Conversation-attachments HTTP integration tests against the
// unified `files` + `file_links` resource (Wave-C Step 6).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog, conversations, fileLinks } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-attach");
  const [c] = await srv.db
    .insert(conversations)
    .values({
      tenant_id: srv.tenantId,
      status: "active",
    })
    .returning();
  conversation_id = c!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${srv.apiKey}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${srv.baseUrl}${path}`, init);
}

describe("POST /v1/conversations/:id/attachments", () => {
  test("uploads an attachment (utf8 source, base64 wire) and returns 201", async () => {
    const raw = "openapi: 3.0.3\ninfo:\n  title: Stripe";
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "stripe-spec.yaml",
      content_type: "application/yaml",
      content_base64: Buffer.from(raw, "utf8").toString("base64"),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      slug: string;
      filename: string;
      size_bytes: number;
      sha256: string;
    };
    expect(body.id).toMatch(/^fid_[0-9a-f-]{36}$/);
    expect(body.slug).toBe("stripe-spec");
    expect(body.filename).toBe("stripe-spec.yaml");
    expect(body.size_bytes).toBeGreaterThan(10);
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("non-existent conversation returns 404", async () => {
    // allow-random: unique per-test id for a 404 lookup.
    const res = await api("POST", `/v1/conversations/${crypto.randomUUID()}/attachments`, {
      filename: "x.txt",
      content_base64: Buffer.from("hello", "utf8").toString("base64"),
    });
    expect(res.status).toBe(404);
  });

  test("oversized body returns 413", async () => {
    // 6 MB utf8 payload — over the 5 MB inline cap.
    const big = "a".repeat(6 * 1024 * 1024);
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "big.txt",
      content_base64: Buffer.from(big, "utf8").toString("base64"),
    });
    expect(res.status).toBe(413);
  });

  test("base64 content_base64 body is decoded", async () => {
    const raw = "hello base64";
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "b64.txt",
      content_type: "text/plain",
      content_base64: encoded,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { size_bytes: number };
    expect(body.size_bytes).toBe(raw.length);
  });

  test("audit row written under the canonical FILE_LINK_ADDED action", async () => {
    await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "for-audit.txt",
      content_base64: Buffer.from("hello audit", "utf8").toString("base64"),
    });
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "file.link_added")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /v1/conversations/:id/attachments", () => {
  test("lists attachments newest-first", async () => {
    const res = await api("GET", `/v1/conversations/${conversation_id}/attachments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachments: Array<{ slug: string; created_at: string }>;
    };
    expect(body.attachments.length).toBeGreaterThanOrEqual(3);
    const ts = body.attachments.map((a) => new Date(a.created_at).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]!).toBeGreaterThanOrEqual(ts[i]!);
    }
  });

  test("404 for unknown conversation", async () => {
    const res = await api("GET", `/v1/conversations/${crypto.randomUUID()}/attachments`); // allow-random: legacy; review before changing
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/conversations/:id/attachments/:slug", () => {
  test("unlinks the file from the conversation (204) but leaves the row", async () => {
    const up = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "to-delete.txt",
      content_base64: Buffer.from("bye", "utf8").toString("base64"),
    });
    const { slug } = (await up.json()) as { slug: string };
    const del = await api("DELETE", `/v1/conversations/${conversation_id}/attachments/${slug}`);
    expect(del.status).toBe(204);
    // The link row is gone.
    const remaining = await srv.db
      .select()
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, srv.tenantId),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, conversation_id),
          eq(fileLinks.slug, slug),
        ),
      );
    expect(remaining.length).toBe(0);
    // Follow-up DELETE is 404 (unlink is idempotent at the slug surface).
    const again = await api("DELETE", `/v1/conversations/${conversation_id}/attachments/${slug}`);
    expect(again.status).toBe(404);
  });
});
