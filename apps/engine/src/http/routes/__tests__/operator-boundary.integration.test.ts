import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getConfig } from "../../../config/loader.ts";
import { apiKeys, rolePermissions, roles, users } from "../../../db/schema/index.ts";
import { handleSubkitSettings, handleSubkitUpdateSetting } from "../../../mcp/tools/settings.ts";
import { logRing } from "../../../observability/index.ts";
import { getRuntimeConfigState, saveRuntimeConfigPatch } from "../../../runtime-config/service.ts";
import {
  bearer,
  type Credential,
  call,
  expectRefused,
  isScopeBoundOauth,
  nonOperatorCredentials,
  operator,
  secondary,
  secondaryPrincipal,
  server,
  setupOperatorBoundary,
  withNodeEnv,
} from "../../tests/operator-boundary-fixtures.ts";
import { browserSessionHeaders } from "../../tests/setup.ts";

setupOperatorBoundary();

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
