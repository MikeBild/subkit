import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, conversations, roles, systemAccounts, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { adminHeaders, seedTenant } from "../../test-helpers/seed.ts";
import { browserSessionHeaders, createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;
let scopedKey = "";
let otherTenantConvId: string;
let privateConvId: string;
let memberHeaders: Record<string, string>;

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

  const otherTenant = await seedTenant(srv.db, { slug: "t-feedback-other", display_name: "other" });
  const [otherConv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: otherTenant.id, status: "active" })
    .returning();
  otherTenantConvId = otherConv!.id;

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "feedback-member@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  if (!member) throw new Error("missing member fixture");
  memberHeaders = await browserSessionHeaders(srv, member.id);
  const [privateConv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", owner_id: member.id, title: "secret" })
    .returning();
  privateConvId = privateConv!.id;
});

async function sendFeedback(id: string, headers: Record<string, string>) {
  const res = await fetch(`${srv.baseUrl}/v1/conversations/${id}/suggest-next/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify({ accepted: true, source: "right-arrow" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations/:id/suggest-next/feedback (RBAC + tenant + Zod)", () => {
  test("admin + valid body → 200 { ok: true }", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(srv.apiKey),
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
          headers: adminHeaders(srv.apiKey),
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
        headers: adminHeaders(srv.apiKey),
        body: JSON.stringify({ accepted: true, source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("a foreign private conversation answers like a missing one, the owner gets 200", async () => {
    const hidden = await sendFeedback(privateConvId, adminHeaders(srv.apiKey));
    const missing = await sendFeedback(crypto.randomUUID(), adminHeaders(srv.apiKey));
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const { request_id: _hiddenRequest, ...hiddenBody } = hidden.body;
    const { request_id: _missingRequest, ...missingBody } = missing.body;
    expect(hiddenBody).toEqual(missingBody);
    expect((await sendFeedback(privateConvId, memberHeaders)).status).toBe(200);
  });

  test("missing `source` → 400 (Zod boundary)", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation_id}/suggest-next/feedback`,
      {
        method: "POST",
        headers: adminHeaders(srv.apiKey),
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
        headers: adminHeaders(srv.apiKey),
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
        headers: adminHeaders(srv.apiKey),
        body: JSON.stringify({ source: "right-arrow" }),
      },
    );
    expect(res.status).toBe(400);
  });
});
