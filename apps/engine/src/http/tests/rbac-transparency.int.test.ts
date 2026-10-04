import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, connectors, roles, users } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function mintKey(opts: {
  userId: string;
  scopes?: string[];
  allowed_connectors?: string[] | null;
}): Promise<string> {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: opts.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: sha256Hex(plaintext),
    scopes: opts.scopes ?? ["*"],
    ...(opts.allowed_connectors !== undefined
      ? { allowed_connectors: opts.allowed_connectors }
      : {}),
  });
  return plaintext;
}

const connectorC1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const connectorC2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";

let memberKey = "";
let ceilingKey = "";

beforeAll(async () => {
  srv = await createHttpTestServer("rbac-transparency");

  for (const id of [connectorC1, connectorC2]) {
    await srv.db.insert(connectors).values({
      id,
      tenant_id: srv.tenantId,
      slug: `conn-${id.slice(0, 4)}`,
      display_name: `Connector ${id.slice(0, 4)}`,
      driver: "http",
    });
  }

  const [noperm] = await srv.db
    .insert(roles)
    .values({ tenant_id: srv.tenantId, name: "noperm" })
    .returning({ id: roles.id });
  if (!noperm) throw new Error("seed noperm role");

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-tx@test.local",
      role_id: noperm.id,
    })
    .returning({ id: users.id });
  if (!member) throw new Error("seed member user");

  const { grantResource } = await import("../../rbac/grants.ts");
  await grantResource(srv.db, {
    tenant_id: srv.tenantId,
    subject_type: "user",
    subject_id: member.id,
    resource_type: "connector",
    resource_id: connectorC1,
    permission: "connector:read",
  });

  memberKey = await mintKey({ userId: member.id });
  ceilingKey = await mintKey({ userId: srv.userId, allowed_connectors: [connectorC2] });
}, 60_000);

afterAll(async () => {
  if (srv) await srv.cleanup();
});

function authGet(path: string, key: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
}

describe("GET /v1/identity/permissions (Stream 3)", () => {
  const path = (id: string) => `/v1/identity/permissions?resource_type=connector&resource_id=${id}`;

  test("admin → read-write", async () => {
    const res = await authGet(path(connectorC1), srv.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { level: string; resource_id: string };
    expect(body.level).toBe("read-write");
    expect(body.resource_id).toBe(connectorC1);
  });

  test("granted member → read-only on C1", async () => {
    const res = await authGet(path(connectorC1), memberKey);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { level: string }).level).toBe("read-only");
  });

  test("ungranted member → none on C2", async () => {
    const res = await authGet(path(connectorC2), memberKey);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { level: string }).level).toBe("none");
  });

  test("credential-ceiling key → none on the excluded connector", async () => {
    const res = await authGet(path(connectorC1), ceilingKey);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { level: string }).level).toBe("none");
  });

  test("missing resource_id → 400", async () => {
    const res = await authGet("/v1/identity/permissions?resource_type=connector", srv.apiKey);
    expect(res.status).toBe(400);
  });

  test("unsupported resource_type → 400", async () => {
    const res = await authGet(
      "/v1/identity/permissions?resource_type=workflow&resource_id=x",
      srv.apiKey,
    );
    expect(res.status).toBe(400);
  });

  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}${path(connectorC1)}`);
    expect(res.status).toBe(401);
  });
});

describe("connector:write 403 envelope (Stream 2)", () => {
  function patchConnector(id: string, key: string): Promise<Response> {
    return fetch(`${srv.baseUrl}/v1/connectors/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "rename attempt" }),
    });
  }

  test("read-only grant → 403 with actionable hint + details", async () => {
    const res = await patchConnector(connectorC1, memberKey);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      hint?: string;
      details?: { connector_level?: string; required?: string; cause?: string };
    };
    expect(body.code).toBe("forbidden");
    expect(body.hint).toContain("read-only");
    expect(body.hint).toContain("read-write");
    expect(body.details?.connector_level).toBe("read-only");
    expect(body.details?.required).toBe("connector:write");
  });

  test("credential ceiling → 403 with connector_level none and a ceiling cause", async () => {
    const res = await patchConnector(connectorC1, ceilingKey);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      details?: { connector_level?: string; cause?: string };
    };
    expect(body.details?.connector_level).toBe("none");
    expect(body.details?.cause).toContain("credential_ceiling");
  });
});
