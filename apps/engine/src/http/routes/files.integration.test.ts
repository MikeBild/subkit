// Integration tests for the unified files HTTP surface.
//
// Covers: full inline cycle, presigned cycle, dedup, range requests,
// RBAC (401 / 403), tenant isolation (404 cross-tenant), and malformed
// finalize rejection. Real Postgres via createHttpTestServer (includes
// loadConfig); real local-disk object store.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, auditLog, roles, tenants, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";

// Deterministic 24-byte source for synthetic api keys. Seeded for replay.
const nextHex = createDeterministicHexFactory(0xf117e7);

function sha256Hex(v: string | Buffer): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey() {
  const rand = Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32);
  const pt = `wf_live_${rand}`;
  return { pt, prefix: pt.slice(0, 12), hash: sha256Hex(pt) };
}

let srv: HttpTestServer;
let tenantBId: string;
let tenantBKey: string;
/** API key bound to a user whose role is `portal_token_user` — that
 *  built-in role lacks `file:read`, `file:write`, and `file:delete`.
 *  Every `/v1/files/*` route should respond 403 for this principal. */
let portalKey: string;

beforeAll(async () => {
  srv = await createHttpTestServer("files-http");

  // Seed a second tenant for cross-tenant isolation tests
  const [tB] = await srv.db
    .insert(tenants)
    .values({ slug: "fhttp-b", display_name: "Files HTTP B" })
    .returning();
  if (!tB) throw new Error("seed tenant B");
  tenantBId = tB.id;

  const [uB] = await srv.db
    .insert(users)
    .values({ tenant_id: tenantBId, email: "admin@fhttp-b.local", role: "admin" })
    .returning();
  if (!uB) throw new Error("seed user B");
  const k = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: tenantBId,
    user_id: uB.id,
    prefix: k.prefix,
    token_sha256: k.hash,
    scopes: ["*"],
  });
  tenantBKey = k.pt;

  // Seed a portal-tier user in tenant A bound to the built-in
  // `portal_token_user` role. That role grants conversation:*
  // permissions but not the file vocabulary; the API key inherits the
  // user's role and the RBAC evaluator returns deny → HTTP 403.
  const [portalRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "portal_token_user")))
    .limit(1);
  if (!portalRole) throw new Error("portal_token_user role not seeded");

  const [portalUser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "portal@fhttp-a.local",
      role: "enduser", // legacy enum; the evaluator reads role_id
      role_id: portalRole.id,
    })
    .returning();
  if (!portalUser) throw new Error("seed portal user");

  const pk = genKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: portalUser.id,
    prefix: pk.prefix,
    token_sha256: pk.hash,
    scopes: ["*"],
  });
  portalKey = pk.pt;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

function post(path: string, bearer: string, body: Record<string, unknown>) {
  return fetch(`${srv.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
}

function getFile(id: string, bearer: string) {
  return fetch(`${srv.baseUrl}/v1/files/${id}`, {
    headers: { authorization: `Bearer ${bearer}`, connection: "close" },
  });
}

function getContent(id: string, bearer: string, range?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    connection: "close",
  };
  if (range) headers.range = range;
  return fetch(`${srv.baseUrl}/v1/files/${id}/content`, { headers });
}

function deleteFile(id: string, bearer: string) {
  return fetch(`${srv.baseUrl}/v1/files/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}`, connection: "close" },
  });
}

describe("files HTTP integration", () => {
  test("full inline cycle: POST inline → GET metadata → GET content → DELETE", async () => {
    const content = "hello files";
    const b64 = Buffer.from(content).toString("base64");

    const cr = await post("/v1/files/inline", srv.apiKey, {
      filename: "hello.txt",
      content_type: "text/plain",
      content_base64: b64,
    });
    expect(cr.status).toBe(201);
    const created = (await cr.json()) as { id: string; status: string; filename: string };
    expect(created.status).toBe("ready");
    expect(created.id).toMatch(/^fid_/);
    expect(created.filename).toBe("hello.txt");

    // GET metadata
    const gr = await getFile(created.id, srv.apiKey);
    expect(gr.status).toBe(200);
    const got = (await gr.json()) as { id: string };
    expect(got.id).toBe(created.id);

    // GET content
    const cr2 = await getContent(created.id, srv.apiKey);
    expect(cr2.status).toBe(200);
    const text = await cr2.text();
    expect(text).toBe(content);

    // DELETE
    const dr = await deleteFile(created.id, srv.apiKey);
    expect(dr.status).toBe(204);
  });

  test("413 on > 5 MiB inline payload", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, "X").toString("base64");
    const res = await post("/v1/files/inline", srv.apiKey, {
      filename: "big.bin",
      content_base64: big,
    });
    expect(res.status).toBe(413);
  });

  test("401 without bearer token", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/files/inline`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({
        filename: "x.txt",
        content_base64: Buffer.from("x").toString("base64"),
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test("404 cross-tenant: tenant B cannot GET tenant A file", async () => {
    const b64 = Buffer.from("isolated").toString("base64");
    const cr = await post("/v1/files/inline", srv.apiKey, {
      filename: "isolated.txt",
      content_base64: b64,
    });
    expect(cr.status).toBe(201);
    const { id } = (await cr.json()) as { id: string };

    const cross = await getFile(id, tenantBKey);
    expect(cross.status).toBe(404);
  });

  test("dedup: second inline upload of same sha256 returns 200 + dedup audit row", async () => {
    const content = "dedup-target-content";
    const b64 = Buffer.from(content).toString("base64");
    const body = { filename: "dup.txt", content_type: "text/plain", content_base64: b64 };

    const first = await post("/v1/files/inline", srv.apiKey, body);
    expect(first.status).toBe(201);
    const r1 = (await first.json()) as { id: string };

    const second = await post("/v1/files/inline", srv.apiKey, body);
    // Dedup hit returns 200
    expect(second.status).toBe(200);
    const r2 = (await second.json()) as { id: string };
    expect(r2.id).toBe(r1.id);

    // Audit row should have dedup:true
    const auditRows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "file.created")));
    const dedupRow = auditRows.find((r) => (r.metadata as Record<string, unknown>).dedup === true);
    expect(dedupRow).toBeDefined();
  });

  test("range request returns 206 Partial Content with exact byte slice", async () => {
    const content = "0123456789abcdef"; // 16 bytes
    const b64 = Buffer.from(content).toString("base64");
    const cr = await post("/v1/files/inline", srv.apiKey, {
      filename: "range.txt",
      content_type: "text/plain",
      content_base64: b64,
    });
    expect(cr.status).toBe(201);
    const { id } = (await cr.json()) as { id: string };

    const rr = await getContent(id, srv.apiKey, "bytes=4-7");
    expect(rr.status).toBe(206);
    const slice = await rr.text();
    expect(slice).toBe("4567");
    const crHeader = rr.headers.get("content-range");
    expect(crHeader).toContain("bytes 4-7/16");
  });

  test("presigned batch-create cycle: batch-create → PUT upload → finalize → GET content", async () => {
    const content = "presigned-content-test";
    const sha256 = sha256Hex(Buffer.from(content));

    const bcr = await post("/v1/files/batch-create", srv.apiKey, {
      files: [
        {
          filename: "presigned.txt",
          content_type: "text/plain",
          size_bytes: Buffer.from(content).byteLength,
          sha256,
        },
      ],
    });
    expect(bcr.status).toBe(201);
    const bcBody = (await bcr.json()) as { files: Array<{ id: string; upload_url: string }> };
    expect(bcBody.files).toHaveLength(1);
    const entry = bcBody.files[0]!;
    expect(entry.id).toMatch(/^fid_/);

    // PUT to the local sink URL
    const putUrl = entry.upload_url.startsWith("http")
      ? entry.upload_url
      : `${srv.baseUrl}${entry.upload_url}`;
    const pr = await fetch(putUrl, {
      method: "PUT",
      headers: { "content-length": String(Buffer.from(content).byteLength), connection: "close" },
      body: content,
    });
    expect(pr.status).toBe(200);

    // finalize
    const fr = await post(`/v1/files/${entry.id}/finalize`, srv.apiKey, { sha256 });
    expect(fr.status).toBe(200);
    const finalized = (await fr.json()) as { status: string };
    expect(finalized.status).toBe("ready");

    // GET content
    const gr = await getContent(entry.id, srv.apiKey);
    expect(gr.status).toBe(200);
    const text = await gr.text();
    expect(text).toBe(content);
  });

  test("finalize with wrong sha256 is rejected with 422", async () => {
    const content = "wrong-sha-content";
    const realSha = sha256Hex(Buffer.from(content));
    // Flip one hex char to make it wrong
    const wrongSha = realSha[0] === "a" ? `b${realSha.slice(1)}` : `a${realSha.slice(1)}`;

    const bcr = await post("/v1/files/batch-create", srv.apiKey, {
      files: [
        {
          filename: "wrongsha.txt",
          content_type: "text/plain",
          size_bytes: Buffer.from(content).byteLength,
        },
      ],
    });
    const bcBody = (await bcr.json()) as { files: Array<{ id: string; upload_url: string }> };
    const entry = bcBody.files[0]!;
    const putUrl = entry.upload_url.startsWith("http")
      ? entry.upload_url
      : `${srv.baseUrl}${entry.upload_url}`;
    await fetch(putUrl, { method: "PUT", body: content });

    const fr = await post(`/v1/files/${entry.id}/finalize`, srv.apiKey, { sha256: wrongSha });
    expect(fr.status).toBe(422);
  });

  test("403 on /v1/files surfaces for principal lacking file:* permissions", async () => {
    // GET /v1/files — needs file:read; portal_token_user lacks it.
    const list = await fetch(`${srv.baseUrl}/v1/files`, {
      headers: { authorization: `Bearer ${portalKey}`, connection: "close" },
    });
    expect(list.status).toBe(403);

    // POST /v1/files/inline — needs file:write; same role lacks it.
    const inline = await fetch(`${srv.baseUrl}/v1/files/inline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${portalKey}`,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        filename: "denied.txt",
        content_base64: Buffer.from("nope").toString("base64"),
      }),
    });
    expect(inline.status).toBe(403);

    // DELETE /v1/files/<some-fid> — needs file:delete. Use a synthetic
    // fid; the permission gate fires before the row lookup, so the
    // existence (or not) of the row is moot.
    const del = await fetch(`${srv.baseUrl}/v1/files/fid_00000000-0000-0000-0000-000000000123`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${portalKey}`, connection: "close" },
    });
    expect(del.status).toBe(403);
  });

  test("audit log entry written on FILE_CREATED without raw size_bytes", async () => {
    const b64 = Buffer.from("audit-me").toString("base64");
    const cr = await post("/v1/files/inline", srv.apiKey, {
      filename: "audit-check.txt",
      content_base64: b64,
    });
    expect(cr.status).toBe(201);
    const { id } = (await cr.json()) as { id: string };
    const uuid = id.slice("fid_".length);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "file.created"),
          eq(auditLog.resource_id, uuid),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.size_bytes_bucket).toBeDefined();
    expect(meta.size_bytes).toBeUndefined();
  });
});
