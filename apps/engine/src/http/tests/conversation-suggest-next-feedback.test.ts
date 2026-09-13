// HTTP-layer coverage for `POST /v1/conversations/:id/suggest-next/feedback`,
// the metric-only feedback route added under the next-message preview
// feature. Pinning the contract here so:
//
//   - admin api key with conversation:read → 200
//   - scoped api key without conversation:read/workflow:read → 403
//   - cross-tenant `:id` → 404 (tenant isolation)
//   - missing required fields / unknown source enum → 400 (Zod boundary)
//
// The route only increments a Prometheus counter and emits a structured
// log line — no audit row, no DB mutation — so this file does not
// assert against `audit_log`.

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { apiKeys, conversations, roles, systemAccounts, tenants } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;
let scopedKey = "";
let otherTenantConvId: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-suggest-next-feedback");

  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", title: "feedback-source" })
    .returning();
  conversation_id = c!.id;

  // Same approach as conversation-fork.test.ts: bind a system account
  // to the `metrics_scraper` role (no conversation/workflow read), so
  // an authenticated request without the right permission returns 403
  // instead of 401. Pinning the 403 path matters because the route is
  // gated only on `conversation:read|workflow:read`; if that gate
  // were ever loosened, this test catches the regression.
  const [scraperRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "metrics_scraper")));
  if (!scraperRole) throw new Error("metrics_scraper role not seeded");
  const [scraperAcct] = await srv.db
    .insert(systemAccounts)
    .values({
      tenant_id: srv.tenantId,
      name: "feedback-denied-scraper",
      description: "scoped to metrics:read only",
      role_id: scraperRole.id,
    })
    .returning();
  const key = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: scraperAcct!.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["metrics:read"],
  });
  scopedKey = key.plaintext;

  // Second tenant for the cross-tenant 404 case.
  const [otherTenant] = await srv.db
    .insert(tenants)
    .values({ slug: "t-feedback-other", display_name: "other" })
    .returning();
  const [otherConv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: otherTenant!.id, status: "active" })
    .returning();
  otherTenantConvId = otherConv!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/conversations/:id/suggest-next/feedback (RBAC + tenant + Zod)", () => {
  test("admin + valid body → 200 { ok: true }", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ accepted: true, source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  test("each `source` enum value is accepted", async () => {
    for (const source of ["right-arrow", "tab", "typed-over", "dismissed"] as const) {
      const res = await fetch(
        `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
        {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ accepted: source !== "dismissed", source }),
        },
      );
      expect(res.status).toBe(200);
    }
  });

  test("scoped api-key without conversation:read/workflow:read → 403", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${scopedKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accepted: true, source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("cross-tenant `:id` → 404 (tenant isolation)", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${otherTenantConvId}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ accepted: true, source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("missing `source` → 400 (Zod boundary)", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ accepted: true }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("unknown `source` enum → 400 (Zod boundary)", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ accepted: true, source: "double-click" }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("missing `accepted` → 400 (Zod boundary)", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(400);
  });
});
