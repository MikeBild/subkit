import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, conversations, roles, users } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

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
let portalKey: string;

beforeAll(async () => {
  srv = await createHttpTestServer("conv-attach-perm-asym");

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
      role_id: portalRole.id,
    })
    .returning();
  if (!portalUser) throw new Error("seed portal user");

  const [conv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", owner_id: portalUser.id })
    .returning();
  if (!conv) throw new Error("seed conversation");
  conversation_id = conv.id;

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

    const metaRes = await api("GET", `/v1/files/${uploaded.id}`, portalKey);
    expect(metaRes.status).toBe(403);

    const contentRes = await api("GET", `/v1/files/${uploaded.id}/content`, portalKey);
    expect(contentRes.status).toBe(403);

    const metaAdmin = await api("GET", `/v1/files/${uploaded.id}`, srv.apiKey);
    expect(metaAdmin.status).toBe(200);
  });
});
