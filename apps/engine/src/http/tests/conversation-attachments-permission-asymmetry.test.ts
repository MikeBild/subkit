// W7 — pin the documented permission asymmetry between the
// conversation-attachments wrapper route and the canonical /v1/files/*
// surface.
//
// `apps/engine/src/http/routes/conversation-attachments.ts` gates on
// `conversation:write` / `conversation:read` (file header lines
// 24-30). The canonical `apps/engine/src/http/routes/files.ts` route
// gates on `file:write` / `file:read` / `file:delete`. The asymmetry
// is intentional — portal-only personas keep upload ergonomics
// without the broader file vocabulary — but it relies on the two
// permission grants staying in lockstep. This test pins the
// contract so a future tightening (e.g. routing the wrapper through
// `file:write` as well) silently breaks here instead of in production.
//
// Scenario: a principal holding `conversation:write` + `conversation:read`
// but NO `file:*` permissions
//   1. can upload a file via POST /v1/conversations/:id/attachments (201)
//   2. cannot read the same file via GET /v1/files/:id (403)
//   3. cannot download the same file via GET /v1/files/:id/content (403)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, conversations, roles, users } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

// Deterministic 24-byte source — seeded for replay.
const nextHex = createDeterministicHexFactory(0xa55ee7);

function sha256Hex(v: string | Buffer): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey() {
  const rand = Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32);
  const pt = `wf_live_${rand}`;
  return { pt, prefix: pt.slice(0, 12), hash: sha256Hex(pt) };
}

let srv: HttpTestServer;
let conversation_id: string;
/** API key bound to a `portal_token_user` — that built-in role grants
 *  conversation:* but no file:*. */
let portalKey: string;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-attach-perm-asym");

  const [conv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conversation");
  conversation_id = conv.id;

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
      email: "portal@conv-attach-asym.local",
      // Legacy enum kept for the column constraint; the RBAC evaluator
      // reads `role_id` (see seeded `portal_token_user` row above).
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

async function api(
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      connection: "close",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${srv.baseUrl}${path}`, init);
}

describe("wrapper vs canonical files surface — documented permission asymmetry", () => {
  test("portal principal (conversation:write, no file:*) can upload via wrapper but cannot read/download via /v1/files/{id}", async () => {
    // Upload via the wrapper — must succeed (201) because the
    // wrapper gates on `conversation:write`.
    const uploadRes = await api(
      "POST",
      `/v1/conversations/${conversation_id}/attachments`,
      portalKey,
      {
        filename: "wrapper-asym.txt",
        content_type: "text/plain",
        content_base64: Buffer.from("portal-only-bytes", "utf8").toString("base64"),
      },
    );
    expect(uploadRes.status).toBe(201);
    const uploaded = (await uploadRes.json()) as { id: string };
    expect(uploaded.id).toMatch(/^fid_/);

    // Read metadata via the canonical surface — must fail with 403
    // because the canonical route gates on `file:read` and the
    // portal_token_user role does not carry `file:*`.
    const metaRes = await api("GET", `/v1/files/${uploaded.id}`, portalKey);
    expect(metaRes.status).toBe(403);

    // Same for the content stream — `file:read` again.
    const contentRes = await api("GET", `/v1/files/${uploaded.id}/content`, portalKey);
    expect(contentRes.status).toBe(403);

    // Sanity check: a `file:*`-carrying principal (the test
    // server's primary admin api key) CAN read the same file via
    // the canonical surface. This pins both halves of the
    // asymmetry — if a future tightening silently routes the
    // canonical route through `conversation:read` (relaxing the
    // gate), this assertion still holds; if it routes through a
    // stricter permission only the admin lacks, this assertion
    // fails loudly.
    const metaAdmin = await api("GET", `/v1/files/${uploaded.id}`, srv.apiKey);
    expect(metaAdmin.status).toBe(200);
  });
});
