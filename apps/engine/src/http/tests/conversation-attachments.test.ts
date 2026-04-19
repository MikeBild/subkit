// Conversation-attachments HTTP integration tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, conversations } from "../../db/schema/index.ts";
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

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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
  test("uploads an attachment and returns 201 with slug", async () => {
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "stripe-spec.yaml",
      content_type: "application/yaml",
      content: "openapi: 3.0.3\ninfo:\n  title: Stripe",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      original_filename: string;
      size_bytes: number;
      sha256: string;
      preview: string;
    };
    expect(body.slug).toBe("stripe-spec");
    expect(body.original_filename).toBe("stripe-spec.yaml");
    expect(body.size_bytes).toBeGreaterThan(10);
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.preview).toContain("openapi: 3.0.3");
  });

  test("non-existent conversation returns 404", async () => {
    const res = await api(
      "POST",
      `/v1/conversations/${crypto.randomUUID()}/attachments`,
      { filename: "x.txt", content: "hello" },
    );
    expect(res.status).toBe(404);
  });

  test("oversized body returns 413", async () => {
    const big = "a".repeat(11 * 1024 * 1024);
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "big.txt",
      content: big,
    });
    expect(res.status).toBe(413);
  });

  test("base64 content is decoded before storage", async () => {
    const raw = "hello base64";
    const encoded = Buffer.from(raw, "utf8").toString("base64");
    const res = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "b64.txt",
      content_type: "text/plain",
      content: encoded,
      content_encoding: "base64",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { size_bytes: number; preview: string };
    expect(body.size_bytes).toBe(raw.length);
    expect(body.preview).toBe(raw);
  });

  test("audit row is written with the created action", async () => {
    await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "for-audit.txt",
      content: "hello audit",
    });
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "conversation.attachment_created"),
        ),
      );
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
    const res = await api(
      "GET",
      `/v1/conversations/${crypto.randomUUID()}/attachments`,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/conversations/:id/attachments/:slug", () => {
  test("deletes an attachment and writes audit", async () => {
    // upload first
    const up = await api("POST", `/v1/conversations/${conversation_id}/attachments`, {
      filename: "to-delete.txt",
      content: "bye",
    });
    const { slug } = (await up.json()) as { slug: string };
    const del = await api(
      "DELETE",
      `/v1/conversations/${conversation_id}/attachments/${slug}`,
    );
    expect(del.status).toBe(204);
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "conversation.attachment_deleted"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // follow-up DELETE is 404 now
    const again = await api(
      "DELETE",
      `/v1/conversations/${conversation_id}/attachments/${slug}`,
    );
    expect(again.status).toBe(404);
  });
});
