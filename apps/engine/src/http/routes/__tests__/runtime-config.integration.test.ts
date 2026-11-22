import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { AuditAction } from "../../../audit/index.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { apiKeys } from "../../../db/schema/identity.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import {
  DATABASE_URL_BOOTSTRAP_SENTINEL,
  initializeRuntimeConfig,
} from "../../../runtime-config/service.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let server: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let configDir: string;
let previousMasterKey: string | undefined;

beforeAll(async () => {
  previousMasterKey = testEnv.MASTER_KEY;
  testEnv.MASTER_KEY = "22".repeat(32);
  testEnv.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "subkit-runtime-http-"));
  _resetConfigForTests();
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/runtime-http",
      NODE_ENV: "test",
    },
    configPathOverride: join(configDir, "seed.json"),
  });
  server = await createHttpTestServer("runtime-config-route");
  await initializeRuntimeConfig(server.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(server.db, "test", "http-replica");
  await coordinator.start();
});

afterAll(async () => {
  await coordinator.stop();
  await server.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = previousMasterKey;
});

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe("runtime configuration HTTP contract", () => {
  test("requires authentication and exposes saved versus active revisions", async () => {
    expect((await fetch(`${server.baseUrl}/v1/settings/runtime`)).status).toBe(401);

    const response = await authedFetch("/v1/settings/runtime");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      saved_revision: number;
      active_revision: number;
      activation_status: string;
      settings: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      saved_revision: 1,
      active_revision: 1,
      activation_status: "active",
    });
    expect(JSON.stringify(body.settings)).not.toContain("22".repeat(32));
    expect((body.settings.database as { url: string }).url).toBe(DATABASE_URL_BOOTSTRAP_SENTINEL);

    const databasePatch = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: 1,
        changes: { "database.url": "postgres://other/runtime" },
        scope: "global",
      }),
    });
    expect(databasePatch.status).toBe(422);

    const secretRefInjection = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: 1,
        changes: { "log.level": "secret://not-a-secret-leaf/1" },
        scope: "global",
      }),
    });
    expect(secretRefInjection.status).toBe(422);

    const readOnlyKey = "wf_live_runtime_read_only_00000000000000000000";
    await server.db.insert(apiKeys).values({
      tenant_id: server.tenantId,
      user_id: server.userId,
      prefix: readOnlyKey.slice(0, 12),
      token_sha256: createHash("sha256").update(readOnlyKey).digest("hex"),
      scopes: ["settings:read"],
    });
    const forbiddenPatch = await fetch(`${server.baseUrl}/v1/settings`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${readOnlyKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "global",
      }),
    });
    expect(forbiddenPatch.status).toBe(403);
  });

  test("creates opaque secret versions, saves refs, and blocks referenced revocation", async () => {
    const plaintext = "http-contract-plaintext-must-not-leak";
    const created = await authedFetch("/v1/secrets/mcp.transport-key/versions", {
      method: "POST",
      body: JSON.stringify({ value: plaintext }),
    });
    expect(created.status).toBe(201);
    const secret = (await created.json()) as {
      reference: string;
      version: number;
    };
    expect(secret.reference).toBe("secret://mcp.transport-key/1");
    expect(JSON.stringify(secret)).not.toContain(plaintext);

    const saved = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: 1,
        changes: { "mcp.api_key": secret.reference },
        scope: "global",
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      saved_revision: 2,
      active_revision: 1,
      activation_status: "saved",
    });

    const activated = await authedFetch("/v1/settings/revisions/2/activate", {
      method: "POST",
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      saved_revision: 2,
      active_revision: 2,
      activation_status: "active",
      replicas: [expect.objectContaining({ instance_id: "http-replica", status: "ack" })],
    });

    const history = await authedFetch("/v1/settings/revisions/2");
    expect(history.status).toBe(200);
    const historyText = await history.text();
    expect(historyText).toContain(secret.reference);
    expect(historyText).not.toContain(plaintext);

    const registry = await authedFetch("/v1/secrets");
    expect(registry.status).toBe(200);
    const registryText = await registry.text();
    expect(registryText).toContain(secret.reference);
    expect(registryText).not.toContain(plaintext);
    expect(registryText).not.toContain("ciphertext");

    const revoke = await authedFetch(
      `/v1/secrets/mcp.transport-key/versions/${secret.version}/revoke`,
      { method: "POST" },
    );
    expect(revoke.status).toBe(409);
    expect(await revoke.json()).toMatchObject({ code: "secret_in_use" });
  });

  test("rejects stale writers and separates restart-required revisions", async () => {
    const stale = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "global",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "revision_conflict" });

    const saved = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: 2,
        changes: { "server.port": 3001 },
        scope: "global",
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      saved_revision: 3,
      active_revision: 2,
      pending_restart_fields: ["server.port"],
    });

    const activation = await authedFetch("/v1/settings/revisions/3/activate", {
      method: "POST",
    });
    expect(activation.status).toBe(200);
    expect(await activation.json()).toMatchObject({
      saved_revision: 3,
      active_revision: 2,
      activation_status: "restart_required",
      pending_restart_fields: ["server.port"],
    });
    expect(getConfig().server.port).toBe(3000);

    const actions = await server.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        inArray(auditLog.action, [
          AuditAction.SECRET_VERSION_CREATED,
          AuditAction.SETTINGS_REVISION_SAVED,
          AuditAction.SETTINGS_REVISION_RESTART_REQUIRED,
        ]),
      );
    expect(new Set(actions.map((row) => row.action))).toEqual(
      new Set([
        AuditAction.SECRET_VERSION_CREATED,
        AuditAction.SETTINGS_REVISION_SAVED,
        AuditAction.SETTINGS_REVISION_RESTART_REQUIRED,
      ]),
    );
  });

  test("one save is one revision: every change lands together or none does", async () => {
    const listed = (await (await authedFetch("/v1/settings")).json()) as {
      saved_revision: number;
    };
    const before = (await (await authedFetch("/v1/settings/revisions")).json()) as {
      items: unknown[];
    };

    const saved = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: listed.saved_revision,
        changes: { "log.level": "debug", "connectors.mcp.per_server_manifest_byte_cap": 50_000 },
        scope: "global",
      }),
    });
    expect(saved.status).toBe(200);
    const state = (await saved.json()) as { saved_revision: number };
    expect(state.saved_revision).toBe(listed.saved_revision + 1);
    const after = (await (await authedFetch("/v1/settings/revisions")).json()) as {
      items: unknown[];
    };
    expect(after.items.length).toBe(before.items.length + 1);
    const revision = (await (
      await authedFetch(`/v1/settings/revisions/${state.saved_revision}`)
    ).json()) as {
      document: {
        log: { level: string };
        connectors: { mcp: { per_server_manifest_byte_cap: number } };
      };
    };
    expect(revision.document.log.level).toBe("debug");
    expect(revision.document.connectors.mcp.per_server_manifest_byte_cap).toBe(50_000);

    const invalid = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: state.saved_revision,
        changes: { "log.level": "warn", "connectors.mcp.per_server_manifest_byte_cap": "a lot" },
        scope: "global",
      }),
    });
    expect(invalid.status).toBe(422);
    const stale = await authedFetch("/v1/settings", {
      method: "PATCH",
      body: JSON.stringify({
        expected_revision: listed.saved_revision,
        changes: { "log.level": "warn" },
        scope: "global",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "revision_conflict" });
    const untouched = (await (await authedFetch("/v1/settings/revisions")).json()) as {
      items: unknown[];
    };
    expect(untouched.items.length).toBe(after.items.length);
    const relisted = (await (await authedFetch("/v1/settings")).json()) as {
      saved_revision: number;
    };
    expect(relisted.saved_revision).toBe(state.saved_revision);
  });
});
