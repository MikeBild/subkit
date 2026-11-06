import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { generateAccessToken } from "../../../auth/oauth/tokens.ts";
import { getConfig } from "../../../config/loader.ts";
import {
  apiKeys,
  mcpOauthAccessTokens,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  mcpOauthUnknownGrants,
} from "../../../db/schema/index.ts";
import { generateKey } from "../../../identity/api-key.ts";
import { handleSubkitSettings, handleSubkitUpdateSetting } from "../../../mcp/tools/settings.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createSecretVersion, getRuntimeConfigState } from "../../../runtime-config/service.ts";
import {
  bearer,
  type Credential,
  call,
  nonOperatorCredentials,
  operator,
  secondary,
  secondaryPrincipal,
  server,
  setupOperatorBoundary,
  withNodeEnv,
} from "../../tests/operator-boundary-fixtures.ts";

setupOperatorBoundary();

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
