// /metrics is gated behind `requireScope("metrics:read")`. The gate
// admits:
//   - unauthenticated requests → 401
//   - authenticated principals without the scope → 403 + audit denied
//   - a scoped `metrics-scraper`-style key → 200 + Prometheus text body
//   - admin principals bypass the scope check → 200
//
// The test spins up its own http server so we can seed the extra api
// keys directly and still reach the same route surface as a real
// scraper.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, systemAccounts, users } from "../../db/schema/index.ts";
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
  srv = await createHttpTestServer("metrics-gate");

  // A system account tagged as the metrics scraper. System accounts
  // inherit the admin role in the v1 surface, so the scope check would
  // pass via admin override on its own; we still give it the
  // `metrics:read` scope so the seed parity test below holds.
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

  // A regular (non-admin) user with an api key that carries a scope
  // unrelated to metrics. Used to verify the 403 + audit denied path.
  const [nonAdmin] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "scoped-user@test.local",
      role: "member",
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

describe("/metrics scope gate", () => {
  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`);
    expect(res.status).toBe(401);
  });

  test("auth without metrics:read → 403 + audit denied", async () => {
    const res = await fetch(`${srv.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${scopedUserKey}` },
    });
    expect(res.status).toBe(403);

    // The audit write is fire-and-forget, so we poll until the row
    // lands (up to ~2 s) rather than gambling on a single `setTimeout`.
    let rows: Array<typeof auditLog.$inferSelect> = [];
    for (let i = 0; i < 20; i += 1) {
      rows = await srv.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "policy.denied")));
      if (rows.some((r) => r.reason === "scope_missing:metrics:read")) break;
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: legacy; review before changing
    }
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

  test("admin api key without explicit scope → 200 (admin override)", async () => {
    // The suite-level admin key carries scopes: ["*"], which does not
    // include the literal `metrics:read` token — we're exercising the
    // admin role bypass, not scope wildcarding.
    const res = await fetch(`${srv.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
  });
});
