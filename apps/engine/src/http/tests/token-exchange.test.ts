import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { apiKeys, auditLog, systemAccounts } from "../../db/schema/index.ts";
import { generateKey } from "../../identity/api-key.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:subkit:params:oauth:token-type:api-key";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("token-exchange");
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ExchangeResponse {
  access_token?: string;
  token_type?: string;
  issued_token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function exchange(
  key: string,
  extra: Record<string, string> = {},
  overrides: Record<string, string> = {},
): Promise<{ status: number; body: ExchangeResponse; headers: Headers }> {
  const form = new URLSearchParams({
    grant_type: GRANT,
    subject_token: key,
    subject_token_type: SUBJECT_TYPE,
    ...extra,
  });
  for (const [k, v] of Object.entries(overrides)) form.set(k, v);
  const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: res.status, body: (await res.json()) as ExchangeResponse, headers: res.headers };
}

async function mintKey(scopes: string[], owner: "user" | "system_account" = "user") {
  const key = generateKey();
  const [row] = await ctx.db
    .insert(apiKeys)
    .values({
      tenant_id: ctx.tenantId,
      ...(owner === "user" ? { user_id: ctx.userId } : { system_account_id: ctx.systemAccountId }),
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes,
    })
    .returning();
  if (!row) throw new Error("mint key failed");
  return { id: row.id, plaintext: key.plaintext };
}

async function whoami(token: string) {
  const res = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("discovery + OpenAPI advertise the grant", () => {
  test("grant_types_supported names RFC 8693", async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grant_types_supported: string[]; token_endpoint: string };
    expect(body.grant_types_supported).toContain(GRANT);
    expect(body.token_endpoint.endsWith("/v1/oauth/token")).toBe(true);
  });

  test("the mounted OpenAPI describes the grant on the token endpoint", async () => {
    const res = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      paths: Record<string, { post?: { description?: string; summary?: string } }>;
    };
    const op = spec.paths["/v1/oauth/token"]?.post;
    expect(op?.description).toContain(GRANT);
    expect(op?.description).toContain(SUBJECT_TYPE);
  });
});

describe("POST /v1/oauth/token grant_type=token-exchange", () => {
  test("mints a short-lived Bearer token — 900 s default, no refresh token", async () => {
    const { status, body, headers } = await exchange(ctx.apiKey);
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.token_type).toBe("Bearer");
    expect(body.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.expires_in).toBe(900);
    expect(body.refresh_token).toBeUndefined();
    expect(body.scope).toBe("*");
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token?.startsWith("wf_")).toBe(false);
  });

  test("ttl is honoured up to 3600 and refused below 1", async () => {
    expect((await exchange(ctx.apiKey, { ttl: "60" })).body.expires_in).toBe(60);
    expect((await exchange(ctx.apiKey, { ttl: "86400" })).body.expires_in).toBe(3600);
    const bad = await exchange(ctx.apiKey, { ttl: "0" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_request");
  });

  test("accepts a JSON body too", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: GRANT,
        subject_token: ctx.apiKey,
        subject_token_type: SUBJECT_TYPE,
        ttl: 120,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ExchangeResponse).expires_in).toBe(120);
  });

  test("refusal codes: wrong token type, missing params, unknown key, bad requested type", async () => {
    const wrongType = await exchange(ctx.apiKey, {}, { subject_token_type: "urn:x:other" });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toBe("invalid_request");

    const missing = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT }).toString(),
    });
    expect(missing.status).toBe(400);

    const unknown = await exchange("wf_live_doesnotexist000000000000000000");
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_grant");

    const badRequested = await exchange(ctx.apiKey, {
      requested_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
    });
    expect(badRequested.status).toBe(400);
    expect(badRequested.body.error).toBe("invalid_request");
  });

  test("scope narrows to a subset of the key's scopes; wider is invalid_scope", async () => {
    const scoped = await mintKey(["workflows:read", "metrics:read"]);
    const narrowed = await exchange(scoped.plaintext, { scope: "metrics:read" });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe("metrics:read");
    const me = await whoami(narrowed.body.access_token ?? "");
    expect(me.status).toBe(200);
    expect(me.body.scopes).toEqual(["metrics:read"]);

    const wider = await exchange(scoped.plaintext, { scope: "metrics:read workflows:write" });
    expect(wider.status).toBe(400);
    expect(wider.body.error).toBe("invalid_scope");
  });

  test("workflow permissions next to workflow:<id> stay permissions of the token", async () => {
    const wildcard = await mintKey(["*"]);
    const workflowId = crypto.randomUUID();
    const narrowed = await exchange(wildcard.plaintext, {
      scope: `workflow:run workflow:read workflow:${workflowId}`,
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe("workflow:run workflow:read");
    const me = await whoami(narrowed.body.access_token ?? "");
    expect(me.status).toBe(200);
    expect(me.body.scopes).toEqual(["workflow:run", "workflow:read"]);
  });
});

describe("the token is accepted exactly like the key", () => {
  test("whoami: same principal, tenant, kind and scopes; provider stays api_key", async () => {
    const viaKey = await whoami(ctx.apiKey);
    const { body } = await exchange(ctx.apiKey);
    const viaToken = await whoami(body.access_token ?? "");
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.id).toBe(viaKey.body.id);
    expect(viaToken.body.tenant_id).toBe(viaKey.body.tenant_id);
    expect(viaToken.body.kind).toBe(viaKey.body.kind);
    expect(viaToken.body.role_name).toBe(viaKey.body.role_name);
    expect(viaToken.body.scopes).toEqual(viaKey.body.scopes);
    expect(viaToken.body.provider).toBe("api_key");
  });

  test("system-account key → token carries the system account", async () => {
    const bot = await mintKey(["*"], "system_account");
    const { body } = await exchange(bot.plaintext);
    const me = await whoami(body.access_token ?? "");
    expect(me.status).toBe(200);
    expect(me.body.kind).toBe("system_account");
    expect(me.body.id).toBe(ctx.systemAccountId);
  });

  test("GET /metrics accepts a token exchanged from a metrics:read key", async () => {
    const [scraper] = await ctx.db
      .insert(systemAccounts)
      .values({
        tenant_id: ctx.tenantId,
        name: "tx-scraper",
        description: "scoped scraper",
        role_id: await builtinRoleId(ctx.db, "metrics_scraper"),
      })
      .returning();
    const key = generateKey();
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      system_account_id: scraper!.id,
      prefix: key.prefix,
      token_sha256: key.hash,
      scopes: ["metrics:read"],
    });
    const { body } = await exchange(key.plaintext);
    const res = await fetch(`${ctx.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  test("operator-verify routes answer the token as they answer the key", async () => {
    const { body } = await exchange(ctx.apiKey);
    for (const path of [
      "/v1/status",
      "/v1/diagnostics/version",
      "/v1/operator/health-digest",
      "/v1/identity/api-keys",
    ]) {
      const viaKey = await fetch(`${ctx.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      });
      const viaToken = await fetch(`${ctx.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(`${path} ${viaToken.status}`).toBe(`${path} ${viaKey.status}`);
      expect(viaToken.status).toBe(200);
    }
  });

  test("POST /mcp initialize accepts the token", async () => {
    const { body } = await exchange(ctx.apiKey);
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "token-exchange-test", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  test("audit: the exchange row names the key's owner; writes with the token carry via", async () => {
    const { body } = await exchange(ctx.apiKey);
    const exchanged = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "api_key.token_exchanged"),
          eq(auditLog.resource_id, ctx.apiKeyId),
        ),
      );
    expect(exchanged.length).toBeGreaterThan(0);
    expect(exchanged[0]?.actor_type).toBe("user");
    expect(exchanged[0]?.actor_id).toBe(ctx.userId);
    const meta = exchanged[0]?.metadata as Record<string, unknown>;
    expect(meta.expires_in).toBe(900);
    expect(JSON.stringify(meta)).not.toContain(ctx.apiKey);

    const issued = await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${body.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["workflow:read"],
        name: "minted-with-token",
      }),
    });
    expect(issued.status).toBe(201);
    const newKey = (await issued.json()) as { id: string };
    await _drainAuditWritesForTests(ctx.db);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "api_key.issued"),
          eq(auditLog.resource_id, newKey.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(ctx.userId);
    const issuedMeta = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(issuedMeta.via).toBe("token_exchange");
  });
});

describe("revocation and tampering", () => {
  test("revoking the key refuses its token at once, and a fresh exchange", async () => {
    const key = await mintKey(["*"]);
    const { body } = await exchange(key.plaintext);
    expect((await whoami(body.access_token ?? "")).status).toBe(200);

    const revoke = await fetch(`${ctx.baseUrl}/v1/identity/api-keys/${key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(revoke.status).toBe(204);

    expect((await whoami(body.access_token ?? "")).status).toBe(401);
    const again = await exchange(key.plaintext);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("invalid_grant");
  });

  test("a rotated-out key's token dies with the key version", async () => {
    const key = await mintKey(["*"]);
    const { body } = await exchange(key.plaintext);
    await ctx.db
      .update(apiKeys)
      .set({ rotating_out_at: new Date(Date.now() - 1000) }) // allow-wall-clock
      .where(and(eq(apiKeys.id, key.id), eq(apiKeys.tenant_id, ctx.tenantId)));
    expect((await whoami(body.access_token ?? "")).status).toBe(401);

    const fresh = await mintKey(["*"]);
    const { body: fresh2 } = await exchange(fresh.plaintext);
    await ctx.db
      .update(apiKeys)
      .set({ token_sha256: generateKey().hash })
      .where(and(eq(apiKeys.id, fresh.id), eq(apiKeys.tenant_id, ctx.tenantId)));
    expect((await whoami(fresh2.access_token ?? "")).status).toBe(401);
  });

  test("a tampered or foreign token is refused", async () => {
    const { body } = await exchange(ctx.apiKey);
    const [h, p, s] = (body.access_token ?? "").split(".");
    const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
    payload.scope = "*";
    payload.tenant_id = "00000000-0000-0000-0000-000000000000";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    expect((await whoami(forged)).status).toBe(401);
    expect((await whoami("eyJhbGciOiJIUzI1NiJ9.e30.x")).status).toBe(401);
  });
});
