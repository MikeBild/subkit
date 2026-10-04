import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, systemAccounts, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let scraperKey = "";
let scopedUserKey = "";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newKeyPlaintext(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("metrics-scoped");

  const [scraperAcct] = await srv.db
    .insert(systemAccounts)
    .values({
      tenant_id: srv.tenantId,
      name: "metrics-scraper",
      description: "Scoped Prometheus scraper",
    })
    .returning();
  const skey = newKeyPlaintext();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: scraperAcct!.id,
    prefix: skey.prefix,
    token_sha256: skey.hash,
    scopes: ["metrics:read"],
  });
  scraperKey = skey.plaintext;

  const [nonAdmin] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "scoped-user@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
    })
    .returning();
  const ukey = newKeyPlaintext();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: nonAdmin!.id,
    prefix: ukey.prefix,
    token_sha256: ukey.hash,
    scopes: ["workflows:read"],
  });
  scopedUserKey = ukey.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("/metrics requires metrics:read", () => {
  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`);
    expect(res.status).toBe(401);
  });

  test("auth without metrics:read → 403 and scope denial audited", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${scopedUserKey}` },
    });
    expect(res.status).toBe(403);

    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: matches the fire-and-forget audit window
    }
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "policy.denied")));
    expect(rows.some((r) => r.reason === "scope_missing:metrics:read")).toBe(true);
  });

  test("metrics-scraper key → 200 + prom text", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${scraperKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith("# HELP")).toBe(true);
  });

  test("admin api key → 200", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
  });
});
