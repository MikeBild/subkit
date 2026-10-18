import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys } from "../../../../db/schema/index.ts";
import { generateKey } from "../../../../identity/api-key.ts";
import { OPERATOR_PERMISSIONS } from "../../../../rbac/catalog.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "../../../tests/setup.ts";

let server: HttpTestServer;
let secondary: SecondaryTenant;

beforeAll(async () => {
  server = await createHttpTestServer("scope-issuance");
  secondary = await createSecondaryTenant(server, "scope-issuance");
});

afterAll(async () => {
  await server.cleanup();
});

async function storedKey(
  tenantId: string,
  userId: string,
  scopes: string[],
): Promise<{ id: string; token: string }> {
  const key = generateKey();
  const [row] = await server.db
    .insert(apiKeys)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes,
    })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error("api key insert failed");
  return { id: row.id, token: key.plaintext };
}

async function boundedKey(tenantId: string, userId: string, scopes: string[]): Promise<string> {
  return (await storedKey(tenantId, userId, scopes)).token;
}

const ENGINE_WIDE = [...OPERATOR_PERMISSIONS].sort();

async function post(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function issue(token: string, ownerId: string, scopes?: string[]): Promise<Response> {
  return post(token, "/v1/identity/api-keys", {
    owner_kind: "user",
    owner_id: ownerId,
    ...(scopes ? { scopes } : {}),
  });
}

describe("API key scope issuance", () => {
  test("an unknown scope is refused with 422 naming it", async () => {
    const response = await issue(server.apiKey, server.userId, ["workflow:read", "nope"]);
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      code: string;
      message: string;
      details: { scopes: string[] };
    };
    expect(body.code).toBe("unknown_scope");
    expect(body.details.scopes).toEqual(["nope"]);
    expect(body.message).toContain("GET /v1/rbac/permissions");
  });

  test("'*' from a scope-limited key is refused", async () => {
    const token = await boundedKey(server.tenantId, server.userId, [
      "api_key:write",
      "workflow:read",
    ]);
    const response = await issue(token, server.userId, ["*"]);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("scope_exceeds_issuer");
    expect(body.message).toContain("Only a credential without scope limits can issue '*'");
  });

  test("a scope the issuing key does not hold is refused", async () => {
    const token = await boundedKey(server.tenantId, server.userId, [
      "api_key:write",
      "workflow:read",
    ]);
    const response = await issue(token, server.userId, ["connector:write"]);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("scope_exceeds_issuer");
  });

  test("omitted scopes inherit the issuing key's own ceiling", async () => {
    const scopes = ["api_key:write", "workflow:read"];
    const token = await boundedKey(server.tenantId, server.userId, scopes);
    const response = await issue(token, server.userId);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { scopes: string[] }).scopes).toEqual(scopes);
  });

  test("a non-operator admin cannot grant engine-wide scopes", async () => {
    expect(ENGINE_WIDE.length).toBeGreaterThan(0);
    for (const scope of ENGINE_WIDE) {
      const response = await issue(secondary.admin.apiKey, secondary.admin.userId, [scope]);
      expect(response.status).toBe(403);
      const body = (await response.json()) as {
        code: string;
        message: string;
        details: { operator_only: string[] };
      };
      expect(body.code).toBe("scope_exceeds_issuer");
      expect(body.details.operator_only).toEqual([scope]);
      expect(body.message).toContain("only the engine operator can grant it");
    }
    const ordinary = await issue(secondary.admin.apiKey, secondary.admin.userId, ["workflow:read"]);
    expect(ordinary.status).toBe(201);
  });

  test("the engine operator can grant every engine-wide scope", async () => {
    for (const scope of ENGINE_WIDE) {
      const response = await issue(server.apiKey, server.userId, [scope]);
      expect({ scope, status: response.status }).toEqual({ scope, status: 201 });
    }
  });

  test("an empty scope list is treated as '*' and needs a credential without limits", async () => {
    const token = await boundedKey(server.tenantId, server.userId, [
      "api_key:write",
      "workflow:read",
    ]);
    const refused = await issue(token, server.userId, []);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("scope_exceeds_issuer");
  });

  test("a key cannot be bound to an owner from another workspace", async () => {
    const response = await issue(secondary.admin.apiKey, server.userId, ["workflow:read"]);
    expect(response.status).toBe(404);
    const foreign = await server.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, secondary.tenantId), eq(apiKeys.user_id, server.userId)));
    expect(foreign).toEqual([]);
  });

  test("a key already bound to another workspace's owner is not renewed by rotation", async () => {
    const bound = await storedKey(secondary.tenantId, server.userId, ["workflow:read"]);
    const response = await post(
      secondary.admin.apiKey,
      `/v1/identity/api-keys/${bound.id}/rotate`,
      {},
    );
    expect(response.status).toBe(404);
    const rows = await server.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.rotated_from_id, bound.id));
    expect(rows).toEqual([]);
  });

  test("a scope-limited key cannot rotate a key without limits", async () => {
    const token = await boundedKey(server.tenantId, server.userId, [
      "api_key:rotate",
      "api_key:read",
    ]);
    const response = await post(token, `/v1/identity/api-keys/${server.apiKeyId}/rotate`, {});
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("scope_exceeds_issuer");
    const rows = await server.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.rotated_from_id, server.apiKeyId));
    expect(rows).toEqual([]);
  });
});

describe("MCP mode markers", () => {
  const mixedScopes = [
    "mcp:authoring",
    "api_key:write",
    "api_key:read",
    "api_key:rotate",
    "identity:write",
    "identity:read",
    "workflow:read",
  ];

  test("a key with a marker and permissions re-issues, re-requests and rotates its own scopes", async () => {
    const mixed = await storedKey(server.tenantId, server.userId, mixedScopes);
    const inherited = await issue(mixed.token, server.userId);
    expect(inherited.status).toBe(201);
    expect(((await inherited.json()) as { scopes: string[] }).scopes).toEqual(mixedScopes);

    const explicit = await issue(mixed.token, server.userId, mixedScopes);
    expect(explicit.status).toBe(201);
    expect(((await explicit.json()) as { scopes: string[] }).scopes).toEqual(mixedScopes);

    const rotated = await post(mixed.token, `/v1/identity/api-keys/${mixed.id}/rotate`, {});
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { new: { scopes: string[] } }).new.scopes).toEqual(
      mixedScopes,
    );
  });

  test("an invite may carry a marker the issuer carries", async () => {
    const mixed = await storedKey(server.tenantId, server.userId, mixedScopes);
    const response = await post(mixed.token, `/v1/identity/users/${server.userId}/invites`, {
      scopes: ["mcp:authoring", "workflow:read"],
    });
    expect(response.status).toBe(201);
  });

  test("a scope-limited key cannot grant a marker it does not carry", async () => {
    const mixed = await storedKey(server.tenantId, server.userId, mixedScopes);
    const response = await issue(mixed.token, server.userId, ["mcp:admin", "workflow:read"]);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; details: { scopes: string[] } };
    expect(body.code).toBe("scope_exceeds_issuer");
    expect(body.details.scopes).toEqual(["mcp:admin"]);
  });

  test("a marker-only key cannot grant a broader marker through the owner's role", async () => {
    const markerOnly = await boundedKey(server.tenantId, server.userId, ["mcp:authoring"]);
    const response = await issue(markerOnly, server.userId, ["mcp:admin"]);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("scope_exceeds_issuer");
    const same = await issue(markerOnly, server.userId, ["mcp:authoring"]);
    expect(same.status).toBe(201);
  });
});

describe("rotation keeps stored scopes", () => {
  test("a key with a retired scope name rotates unchanged", async () => {
    const scopes = ["workflow:read", "workflow:invoke"];
    const legacy = await storedKey(secondary.tenantId, secondary.admin.userId, scopes);
    const response = await post(
      secondary.admin.apiKey,
      `/v1/identity/api-keys/${legacy.id}/rotate`,
      {},
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { new: { scopes: string[] } }).new.scopes).toEqual(scopes);
  });

  test("a non-operator admin rotates a key that carries an inert engine-wide scope", async () => {
    const scopes = ["mcp:authoring", "workflow:read", "metrics:read"];
    const backfilled = await storedKey(secondary.tenantId, secondary.admin.userId, scopes);
    const response = await post(
      secondary.admin.apiKey,
      `/v1/identity/api-keys/${backfilled.id}/rotate`,
      {},
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { new: { scopes: string[] } }).new.scopes).toEqual(scopes);
  });

  test("omitted scopes inherit a marker-bearing key's scopes, inert ones included", async () => {
    const scopes = ["mcp:authoring", "api_key:write", "workflow:read", "metrics:read"];
    const issuer = await boundedKey(secondary.tenantId, secondary.admin.userId, scopes);
    const response = await issue(issuer, secondary.admin.userId);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { scopes: string[] }).scopes).toEqual(scopes);
  });

  test("a scope-limited key still cannot rotate a key that holds more than it does", async () => {
    const broader = await storedKey(secondary.tenantId, secondary.admin.userId, [
      "workflow:read",
      "connector:write",
    ]);
    const narrow = await boundedKey(secondary.tenantId, secondary.admin.userId, [
      "api_key:rotate",
      "workflow:read",
    ]);
    const response = await post(narrow, `/v1/identity/api-keys/${broader.id}/rotate`, {});
    expect(response.status).toBe(403);
    expect(((await response.json()) as { details: { scopes: string[] } }).details.scopes).toEqual([
      "connector:write",
    ]);
  });
});

describe("invite scope issuance", () => {
  test("an invite applies the same checks", async () => {
    const path = `/v1/identity/users/${secondary.member.userId}/invites`;
    const unknown = await post(secondary.admin.apiKey, path, { scopes: ["nope"] });
    expect(unknown.status).toBe(422);
    for (const scope of ENGINE_WIDE) {
      const engineWide = await post(secondary.admin.apiKey, path, { scopes: [scope] });
      expect(engineWide.status).toBe(403);
      expect(((await engineWide.json()) as { code: string }).code).toBe("scope_exceeds_issuer");
    }
    const ordinary = await post(secondary.admin.apiKey, path, { scopes: ["workflow:read"] });
    expect(ordinary.status).toBe(201);
  });
});
