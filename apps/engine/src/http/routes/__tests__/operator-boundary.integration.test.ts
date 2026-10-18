import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { generateAccessToken } from "../../../auth/oauth/tokens.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../../config/loader.ts";
import {
  apiKeys,
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
  rolePermissions,
  roles,
  users,
} from "../../../db/schema/index.ts";
import { generateKey } from "../../../identity/api-key.ts";
import { handleSubkitSettings, handleSubkitUpdateSetting } from "../../../mcp/tools/settings.ts";
import { logRing } from "../../../observability/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import {
  createSecretVersion,
  getRuntimeConfigState,
  initializeRuntimeConfig,
  saveRuntimeConfigPatch,
} from "../../../runtime-config/service.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "../../tests/setup.ts";

let server: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let secondary: SecondaryTenant;
let configDir: string;
let previousMasterKey: string | undefined;

type Credential = { label: string; headers: () => Promise<Record<string, string>> };

function bearer(token: string): () => Promise<Record<string, string>> {
  return async () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
}

function nonOperatorCredentials(): Credential[] {
  return [
    { label: "admin api key", headers: bearer(secondary.admin.apiKey) },
    { label: "admin browser session", headers: secondary.admin.sessionHeaders },
    { label: "member api key", headers: bearer(secondary.member.apiKey) },
    { label: "member browser session", headers: secondary.member.sessionHeaders },
    { label: "admin MCP OAuth token", headers: bearer(secondary.admin.oauthToken) },
    { label: "member MCP OAuth token", headers: bearer(secondary.member.oauthToken) },
  ];
}

async function call(
  credential: Credential,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: await credential.headers(),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const operator: Credential = {
  label: "operator admin",
  headers: async () => bearer(server.apiKey)(),
};

beforeAll(async () => {
  previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = "44".repeat(32);
  process.env.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "sk-operator-boundary-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/operator-boundary", NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  server = await createHttpTestServer("operator-boundary");
  await initializeRuntimeConfig(server.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(server.db, "test", "operator-boundary-replica");
  await coordinator.start();
  secondary = await createSecondaryTenant(server, "operator-boundary");
});

afterAll(async () => {
  await coordinator.stop();
  await server.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = previousMasterKey;
});

async function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

function isScopeBoundOauth(credential: Credential): boolean {
  return credential.label.endsWith("MCP OAuth token");
}

function secondaryPrincipal(scopes: string[]): ResolvedPrincipal {
  return {
    provider: "api_key",
    kind: "user",
    id: secondary.admin.userId,
    tenant_id: secondary.tenantId,
    roles: ["admin"],
    scopes,
  };
}

async function expectRefused(
  response: Response,
  codes: string[],
  options: { scopeBound?: boolean } = {},
): Promise<string> {
  const text = await response.text();
  expect(response.status).toBe(403);
  const body = JSON.parse(text) as {
    code: string;
    message: string;
    details?: { cause?: string };
  };
  if (options.scopeBound && body.message === "scope_missing:metrics:read") {
    expect(body.code).toBe("forbidden");
    expect(body.details).toBeUndefined();
  } else if (body.code === "forbidden") expect(body.details?.cause).toBe("operator_only");
  else expect(codes).toContain(body.code);
  expect(text).not.toContain(server.tenantId);
  return text;
}

describe("non-operator tenants cannot change the engine", () => {
  test("global settings writes are refused, with and without force, in every mode", async () => {
    const before = await getRuntimeConfigState(server.db);
    for (const mode of ["production", "test"]) {
      await withNodeEnv(mode, async () => {
        for (const credential of nonOperatorCredentials()) {
          for (const body of [{ value: "debug" }, { value: "debug", force: true }]) {
            const response = await call(credential, "/v1/settings/log.level", {
              method: "PUT",
              body,
            });
            const text = await expectRefused(response, ["operator_required"]);
            expect(text).toContain("applies to the whole engine");
          }
          const tenantLeaf = await call(credential, "/v1/settings/llm.model", {
            method: "PUT",
            body: { value: "global-attempt" },
          });
          const text = await expectRefused(tenantLeaf, ["operator_required"]);
          expect(text).toContain("?tenant=");
        }
      });
    }
    expect(getConfig().log.level).not.toBe("debug");
    expect(await getRuntimeConfigState(server.db)).toEqual(before);
  });

  test("another tenant's settings cannot be written or read", async () => {
    for (const credential of nonOperatorCredentials()) {
      const write = await call(credential, `/v1/settings/llm.model?tenant=${server.tenantId}`, {
        method: "PUT",
        body: { value: "cross-tenant" },
      });
      expect(write.status).toBe(403);
      expect(((await write.json()) as { code: string }).code).toBe("scope_violation");
      const read = await call(credential, `/v1/settings?tenant=${server.tenantId}`);
      expect(read.status).toBe(403);
      expect(((await read.json()) as { code: string }).code).toBe("scope_violation");
    }
  });

  test("revision, secret, approval and restart writes are operator-only", async () => {
    const state = await getRuntimeConfigState(server.db);
    for (const credential of nonOperatorCredentials()) {
      const attempts: Array<[string, string, unknown]> = [
        [
          "PATCH",
          "/v1/settings",
          {
            expected_revision: state.saved_revision,
            changes: { "log.level": "warn" },
            scope: "global",
          },
        ],
        [
          "PATCH",
          "/v1/settings",
          {
            expected_revision: state.saved_revision,
            changes: { "llm.model": "tenant-patch" },
            scope: "tenant",
            tenant_id: secondary.tenantId,
          },
        ],
        ["POST", `/v1/settings/revisions/${state.saved_revision}/activate`, undefined],
        ["POST", "/v1/secrets/operator-boundary-secret/versions", { value: "attempt" }],
        ["POST", "/v1/secrets/operator-boundary-secret/versions/1/revoke", undefined],
        ["POST", "/v1/secret-approvals/operator-boundary-secret/1/approve", undefined],
        ["POST", "/v1/secret-approvals/operator-boundary-secret/1/reject", undefined],
        ["POST", "/v1/system/restart", undefined],
      ];
      for (const [method, path, body] of attempts) {
        const response = await call(credential, path, {
          method,
          ...(body !== undefined ? { body } : {}),
        });
        await expectRefused(response, []);
      }
    }
    expect(await getRuntimeConfigState(server.db)).toEqual(state);
  });

  test("engine-wide reads are operator-only and leak no other tenant", async () => {
    const paths = [
      "/v1/settings/runtime",
      "/v1/settings/revisions",
      "/v1/settings/revisions/1",
      "/v1/settings/activations/1",
      "/v1/secrets",
      "/v1/secret-approvals",
      "/v1/system/restart-status",
      "/v1/diagnostics/setup",
      "/v1/diagnostics/llm",
      "/v1/diagnostics/runtime",
      "/v1/diagnostics/drift",
      "/metrics",
    ];
    for (const credential of nonOperatorCredentials()) {
      for (const path of paths) {
        const response = await call(credential, path);
        await expectRefused(response, [], {
          scopeBound: path === "/metrics" && isScopeBoundOauth(credential),
        });
      }
    }
  });

  test("the settings list is a tenant view of tenant leaves only", async () => {
    for (const credential of nonOperatorCredentials()) {
      const response = await call(credential, "/v1/settings");
      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as {
        view: string;
        tenant_id: string;
        saved_revision: number | null;
        items: Array<{ path: string; meta: { scope: string; source: string } }>;
        diagnostics: { override_keys: string[]; pending_restart_keys: string[] };
      };
      expect(body.view).toBe("tenant");
      expect(body.tenant_id).toBe(secondary.tenantId);
      expect(body.saved_revision).toBeNull();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((item) => item.meta.scope === "tenant")).toBe(true);
      expect(body.items.some((item) => item.path.startsWith("tenants"))).toBe(false);
      expect(body.items.every((item) => item.meta.source !== "override")).toBe(true);
      expect(body.diagnostics).toEqual({ override_keys: [], pending_restart_keys: [] });
      expect(text).not.toContain(server.tenantId);

      const globalLeaf = await call(credential, "/v1/settings/log.level");
      expect(globalLeaf.status).toBe(403);
      const globalBody = (await globalLeaf.json()) as { code: string; message: string };
      expect(globalBody.code).toBe("operator_required");
      expect(globalBody.message).toContain("applies to the whole engine");
      const unknownLeaf = await call(credential, "/v1/settings/no.such.leaf");
      expect(unknownLeaf.status).toBe(404);
      const tenantLeaf = await call(credential, "/v1/settings/llm.model");
      expect(tenantLeaf.status).toBe(200);
    }
  });

  test("engine log lines and other tenants' lines stay invisible", async () => {
    const marker = "operator-boundary-log-marker";
    logRing.record({ ts: 1, level: "info", msg: `${marker}-untagged`, fields: {} });
    logRing.record({
      ts: 1,
      level: "info",
      msg: `${marker}-operator`,
      fields: { tenant_id: server.tenantId },
    });
    logRing.record({
      ts: 1,
      level: "info",
      msg: `${marker}-own`,
      fields: { tenant_id: secondary.tenantId },
    });
    const own = await call(
      nonOperatorCredentials()[0] as Credential,
      "/v1/diagnostics/logs?limit=2000",
    );
    expect(own.status).toBe(200);
    const messages = ((await own.json()) as { entries: Array<{ msg?: string }> }).entries.map(
      (entry) => entry.msg,
    );
    expect(messages).toContain(`${marker}-own`);
    expect(messages).not.toContain(`${marker}-untagged`);
    expect(messages).not.toContain(`${marker}-operator`);

    const engine = await call(operator, "/v1/diagnostics/logs?limit=2000");
    const engineMessages = (
      (await engine.json()) as { entries: Array<{ msg?: string }> }
    ).entries.map((entry) => entry.msg);
    expect(engineMessages).toEqual(
      expect.arrayContaining([`${marker}-untagged`, `${marker}-operator`, `${marker}-own`]),
    );
  });

  test("a stored engine-wide scope and a custom role grant stay inert outside the operator", async () => {
    const legacyKey = "wf_live_operator_boundary_legacy_scope_000000";
    await server.db.insert(apiKeys).values({
      tenant_id: secondary.tenantId,
      user_id: secondary.admin.userId,
      prefix: legacyKey.slice(0, 12),
      token_sha256: createHash("sha256").update(legacyKey).digest("hex"),
      scopes: ["*", "settings:write:global"],
    });
    const legacy = { label: "legacy scope", headers: bearer(legacyKey) };
    await expectRefused(
      await call(legacy, "/v1/settings/log.level", { method: "PUT", body: { value: "debug" } }),
      ["operator_required"],
    );
    await expectRefused(await call(legacy, "/v1/settings/runtime"), []);
    const crossWrite = await call(legacy, `/v1/settings/llm.model?tenant=${server.tenantId}`, {
      method: "PUT",
      body: { value: "legacy-cross-tenant" },
    });
    expect(crossWrite.status).toBe(403);
    const crossWriteText = await crossWrite.text();
    expect((JSON.parse(crossWriteText) as { code: string }).code).toBe("scope_violation");
    const crossRead = await call(legacy, `/v1/settings?tenant=${server.tenantId}`);
    expect(crossRead.status).toBe(403);
    expect(((await crossRead.json()) as { code: string }).code).toBe("scope_violation");
    const legacyPrincipal = secondaryPrincipal(["*", "settings:write:global"]);
    const mcpRead = await handleSubkitSettings(
      { db: server.db, principal: legacyPrincipal },
      { tenant_id: server.tenantId },
    );
    expect(mcpRead).toMatchObject({ ok: false, data: { error_code: "scope_violation" } });
    const mcpWrite = await handleSubkitUpdateSetting(
      { db: server.db, principal: legacyPrincipal },
      { path: "llm.model", value: "legacy-cross-tenant", tenant_id: server.tenantId },
    );
    expect(mcpWrite).toMatchObject({ ok: false, data: { error_code: "scope_violation" } });
    expect(getConfig(server.tenantId).llm.model).not.toBe("legacy-cross-tenant");

    const [role] = await server.db
      .insert(roles)
      .values({ tenant_id: secondary.tenantId, name: "restarter", description: "custom" })
      .returning({ id: roles.id });
    if (!role) throw new Error("custom role insert failed");
    const { permissions } = await import("../../../db/schema/index.ts");
    const [restart] = await server.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.name, "system:restart"));
    if (!restart) throw new Error("system:restart permission missing");
    await server.db.insert(rolePermissions).values({ role_id: role.id, permission_id: restart.id });
    const [custom] = await server.db
      .insert(users)
      .values({
        tenant_id: secondary.tenantId,
        email: "restarter@secondary.test",
        role_id: role.id,
      })
      .returning({ id: users.id });
    if (!custom) throw new Error("custom user insert failed");
    const headers = await browserSessionHeaders(
      { db: server.db, tenantId: secondary.tenantId },
      custom.id,
    );
    const response = await fetch(`${server.baseUrl}/v1/system/restart`, {
      method: "POST",
      headers,
    });
    await expectRefused(response, []);
  });

  test("Cockpit bootstrap and whoami mark the workspace as not the engine operator", async () => {
    const response = await call(
      { label: "admin session", headers: secondary.admin.sessionHeaders },
      "/v1/cockpit/bootstrap",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenant: { engine_operator: boolean };
      permissions: string[];
    };
    expect(body.tenant.engine_operator).toBe(false);
    for (const permission of [
      "settings:read:global",
      "settings:write:global",
      "system:restart",
      "metrics:read",
      "mcp_oauth_client:disable",
    ]) {
      expect(body.permissions).not.toContain(permission);
    }
    const whoami = await call(nonOperatorCredentials()[0] as Credential, "/v1/identity/whoami");
    expect(((await whoami.json()) as { engine_operator: boolean }).engine_operator).toBe(false);
    const operatorWhoami = await call(operator, "/v1/identity/whoami");
    expect(((await operatorWhoami.json()) as { engine_operator: boolean }).engine_operator).toBe(
      true,
    );
  });
});

describe("non-operator tenant overlays", () => {
  test("a tenant leaf saves for the caller's own workspace", async () => {
    await withNodeEnv("test", async () => {
      const response = await call(
        nonOperatorCredentials()[0] as Credential,
        `/v1/settings/llm.model?tenant=${secondary.tenantId}`,
        { method: "PUT", body: { value: "tenant-own-model" } },
      );
      expect(response.status).toBe(200);
    });
    expect(getConfig(secondary.tenantId).llm.model).toBe("tenant-own-model");
    const read = await call(nonOperatorCredentials()[2] as Credential, "/v1/settings/llm.model");
    expect(((await read.json()) as { value: unknown; meta: { source: string } }).meta.source).toBe(
      "tenant",
    );
  });

  test("a pending operator revision blocks the tenant write and stays inactive", async () => {
    const state = await getRuntimeConfigState(server.db);
    const pending = await saveRuntimeConfigPatch(server.db, {
      expected_revision: state.saved_revision,
      changes: { "log.level": "warn" },
      scope: "global",
      created_by: server.userId,
    });
    await withNodeEnv("production", async () => {
      const response = await call(
        nonOperatorCredentials()[0] as Credential,
        `/v1/settings/llm.model?tenant=${secondary.tenantId}`,
        { method: "PUT", body: { value: "while-pending" } },
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("operator_change_pending");
      expect(body.message).toContain("Your workspace setting was not saved");
    });
    const after = await getRuntimeConfigState(server.db);
    expect(after.saved_revision).toBe(pending.saved_revision);
    expect(after.active_revision).toBe(state.active_revision);
    expect(getConfig(secondary.tenantId).llm.model).not.toBe("while-pending");

    const activated = await call(
      operator,
      `/v1/settings/revisions/${pending.saved_revision}/activate`,
      {
        method: "POST",
      },
    );
    expect(activated.status).toBe(200);
  });
});

describe("MCP OAuth clients", () => {
  test("a non-operator admin revokes only its own tenant's access", async () => {
    const clientId = "operator-boundary-shared-client";
    await server.db.insert(mcpOauthClients).values({ client_id: clientId, scope: "mcp:read" });
    const tokens: Array<{ tenant_id: string; user_id: string }> = [
      { tenant_id: server.tenantId, user_id: server.userId },
      { tenant_id: secondary.tenantId, user_id: secondary.admin.userId },
    ];
    let seq = 0;
    for (const token of tokens) {
      seq += 1;
      await server.db.insert(mcpOauthAccessTokens).values({
        ...token,
        client_id: clientId,
        prefix: `wf_mcp_ob${seq}`,
        token_sha256: createHash("sha256").update(`operator-boundary-${seq}`).digest("hex"),
        scope: "mcp:read",
        expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live token fixture
      });
    }
    await server.db.insert(mcpOauthGrants).values([
      { tenant_id: server.tenantId, client_id: clientId, user_id: server.userId },
      { tenant_id: secondary.tenantId, client_id: clientId, user_id: secondary.admin.userId },
    ]);
    for (const token of tokens) {
      seq += 1;
      await server.db.insert(mcpOauthRefreshTokens).values({
        ...token,
        client_id: clientId,
        grant_id: null,
        prefix: `wf_mcpr_ob${seq}`,
        token_sha256: createHash("sha256").update(`operator-boundary-refresh-${seq}`).digest("hex"),
        scope: "mcp:read",
        expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live token fixture
      });
    }
    const otherClient = "operator-boundary-operator-only-client";
    await server.db.insert(mcpOauthClients).values({ client_id: otherClient, scope: "mcp:read" });

    const admin = nonOperatorCredentials()[0] as Credential;
    const list = await call(admin, "/v1/oauth/clients");
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { items: Array<{ client_id: string }> }).items.map(
      (item) => item.client_id,
    );
    expect(listed).toContain(clientId);
    expect(listed).not.toContain(otherClient);

    expect(
      (await call(admin, `/v1/oauth/clients/${otherClient}`, { method: "DELETE" })).status,
    ).toBe(404);
    const revoked = await call(admin, `/v1/oauth/clients/${clientId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ client_id: clientId, effect: "tenant_access_revoked" });

    const [client] = await server.db
      .select({ disabled_at: mcpOauthClients.disabled_at })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(client?.disabled_at).toBeNull();
    const live = await server.db
      .select({ tenant_id: mcpOauthAccessTokens.tenant_id })
      .from(mcpOauthAccessTokens)
      .where(
        and(eq(mcpOauthAccessTokens.client_id, clientId), isNull(mcpOauthAccessTokens.revoked_at)),
      );
    expect(live).toEqual([{ tenant_id: server.tenantId }]);
    const liveGrants = await server.db
      .select({ tenant_id: mcpOauthGrants.tenant_id })
      .from(mcpOauthGrants)
      .where(and(eq(mcpOauthGrants.client_id, clientId), isNull(mcpOauthGrants.revoked_at)));
    expect(liveGrants).toEqual([{ tenant_id: server.tenantId }]);
    const liveRefresh = await server.db
      .select({ tenant_id: mcpOauthRefreshTokens.tenant_id })
      .from(mcpOauthRefreshTokens)
      .where(
        and(
          eq(mcpOauthRefreshTokens.client_id, clientId),
          isNull(mcpOauthRefreshTokens.revoked_at),
        ),
      );
    expect(liveRefresh).toEqual([{ tenant_id: server.tenantId }]);
    const unknownGrants = await server.db
      .select({ tenant_id: mcpOauthUnknownGrants.tenant_id })
      .from(mcpOauthUnknownGrants)
      .where(eq(mcpOauthUnknownGrants.client_id, clientId));
    expect(unknownGrants).toEqual([{ tenant_id: secondary.tenantId }]);

    const disabled = await call(operator, `/v1/oauth/clients/${clientId}`, { method: "DELETE" });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ client_id: clientId, effect: "client_disabled" });
    const operatorList = await call(operator, "/v1/oauth/clients");
    const operatorListed = (
      (await operatorList.json()) as { items: Array<{ client_id: string }> }
    ).items.map((item) => item.client_id);
    expect(operatorListed).toEqual(expect.arrayContaining([clientId, otherClient]));
  });
});

describe("tenant secret settings", () => {
  test("a non-operator cannot point its secret setting at a secret it does not own", async () => {
    const foreign = await createSecretVersion(server.db, {
      name: `tenants.${server.tenantId}.settings.llm.api_key`,
      value: "sk-operator-tenant",
      created_by: server.userId,
    });
    const engineWide = await createSecretVersion(server.db, {
      name: "settings.llm.api_key",
      value: "sk-engine-wide",
      created_by: server.userId,
    });
    const references = [
      foreign.reference,
      engineWide.reference,
      "secret://settings.llm.never-created/1",
    ];
    const before = await getRuntimeConfigState(server.db);
    await withNodeEnv("production", async () => {
      const answers = new Set<string>();
      for (const credential of nonOperatorCredentials().slice(0, 4)) {
        for (const reference of references) {
          const response = await call(
            credential as Credential,
            `/v1/settings/llm.api_key?tenant=${secondary.tenantId}`,
            { method: "PUT", body: { value: reference } },
          );
          expect(response.status).toBe(422);
          const body = (await response.json()) as { code: string; message: string };
          answers.add(`${body.code}:${body.message}`);
        }
      }
      for (const reference of references) {
        const result = await handleSubkitUpdateSetting(
          { db: server.db, principal: secondaryPrincipal(["*"]) },
          { path: "llm.api_key", value: reference, tenant_id: secondary.tenantId },
        );
        expect(result.ok).toBe(false);
        const data = (result as { data: { error_code: string; message: string } }).data;
        answers.add(`mcp:${data.error_code}:${data.message}`);
      }
      expect(answers.size).toBe(2);
    });
    expect(await getRuntimeConfigState(server.db)).toEqual(before);
    expect(getConfig(secondary.tenantId).llm.api_key).not.toBe("sk-operator-tenant");
    expect(getConfig(secondary.tenantId).llm.api_key).not.toBe("sk-engine-wide");
  });

  test("an engine-only setting read through MCP names the operator, not an unknown path", async () => {
    const result = await handleSubkitSettings(
      { db: server.db, principal: secondaryPrincipal(["*"]) },
      { path: "log.level" },
    );
    expect(result).toMatchObject({ ok: false, data: { error_code: "operator_required" } });
  });
});

describe("metrics scraping outside the operator", () => {
  test("a metrics scraper and a metrics-scoped OAuth token of another workspace are refused", async () => {
    const { systemAccounts } = await import("../../../db/schema/index.ts");
    const [account] = await server.db
      .insert(systemAccounts)
      .values({
        tenant_id: secondary.tenantId,
        name: "metrics-scraper-secondary",
        description: "scraper",
        role_id: await builtinRoleId(server.db, "metrics_scraper"),
      })
      .returning({ id: systemAccounts.id });
    if (!account) throw new Error("scraper insert failed");
    const scraperKey = generateKey();
    await server.db.insert(apiKeys).values({
      tenant_id: secondary.tenantId,
      system_account_id: account.id,
      prefix: scraperKey.prefix,
      token_sha256: scraperKey.hash,
      scopes: ["metrics:read"],
    });
    const clientId = "operator-boundary-metrics-client";
    await server.db
      .insert(mcpOauthClients)
      .values({ client_id: clientId, scope: "mcp:read metrics:read" });
    const token = generateAccessToken();
    await server.db.insert(mcpOauthAccessTokens).values({
      tenant_id: secondary.tenantId,
      client_id: clientId,
      user_id: secondary.admin.userId,
      prefix: token.prefix,
      token_sha256: token.hash,
      scope: "mcp:read metrics:read",
      resource: `${server.baseUrl}/mcp`,
      expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live token fixture
    });
    for (const credential of [
      { label: "secondary scraper", headers: bearer(scraperKey.plaintext) },
      { label: "secondary metrics oauth", headers: bearer(token.plaintext) },
    ]) {
      const response = await call(credential, "/metrics");
      expect(response.status).toBe(403);
      const body = (await response.json()) as { details?: { cause?: string } };
      expect({ label: credential.label, cause: body.details?.cause }).toEqual({
        label: credential.label,
        cause: "operator_only",
      });
    }
  });
});

describe("the operator keeps engine authority", () => {
  test("engine reads, engine view and metrics scraping work for the operator", async () => {
    const state = await getRuntimeConfigState(server.db);
    for (const path of [
      "/v1/settings/runtime",
      "/v1/settings/revisions",
      `/v1/settings/revisions/${state.saved_revision}`,
      `/v1/settings/activations/${state.active_revision}`,
      "/v1/diagnostics/drift",
      "/v1/secrets",
      "/v1/secret-approvals",
      "/v1/system/restart-status",
      "/v1/diagnostics/setup",
      "/v1/diagnostics/llm",
      "/v1/diagnostics/runtime",
      "/metrics",
    ]) {
      expect({ path, status: (await call(operator, path)).status }).toEqual({ path, status: 200 });
    }
    const list = (await (await call(operator, "/v1/settings")).json()) as { view: string };
    expect(list.view).toBe("engine");
    const other = await call(operator, `/v1/settings?tenant=${secondary.tenantId}`);
    expect(other.status).toBe(200);
  });

  test("a metrics scraper of the operator workspace can scrape", async () => {
    const scraperKey = "wf_live_scrp_operator_boundary_scraper_000000";
    const { systemAccounts } = await import("../../../db/schema/index.ts");
    const [account] = await server.db
      .insert(systemAccounts)
      .values({
        tenant_id: server.tenantId,
        name: "metrics-scraper-operator-boundary",
        description: "scraper",
        role_id: await builtinRoleId(server.db, "metrics_scraper"),
      })
      .returning({ id: systemAccounts.id });
    if (!account) throw new Error("scraper insert failed");
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      system_account_id: account.id,
      prefix: scraperKey.slice(0, 12),
      token_sha256: createHash("sha256").update(scraperKey).digest("hex"),
      scopes: ["metrics:read"],
    });
    const response = await fetch(`${server.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${scraperKey}` },
    });
    expect(response.status).toBe(200);
  });
});
