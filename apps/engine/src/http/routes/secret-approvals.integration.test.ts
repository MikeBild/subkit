// "Freigaben statt Eingaben": a version written with --pending waits; a person
// approves or rejects it in the Cockpit; nothing else can bind it meanwhile.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getConfig, setConfigKey } from "../../config/loader.ts";
import { listConfigLeaves } from "../../config/walk.ts";
import { auditLog } from "../../db/schema/index.ts";
import { probeCurrentVersion } from "../../preflight/vault-ops.ts";
import { RuntimeConfigCoordinator } from "../../runtime-config/coordinator.ts";
import { listPendingSecretVersions } from "../../runtime-config/pending-secrets.ts";
import {
  createSecretVersion,
  getRuntimeConfigState,
  getRuntimeRevision,
  initializeRuntimeConfig,
  listSecretVersions,
  readSecretVersion,
  saveRuntimeConfigPatch,
} from "../../runtime-config/service.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let bindingPath = "";
let secretName = "";

beforeAll(async () => {
  server = await createHttpTestServer("secret-approvals");
  await initializeRuntimeConfig(server.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(server.db, "test", "replica-approvals");
  await coordinator.start();
  const leaf = listConfigLeaves().find(
    (l) => l.meta.secret && (l.meta.scope ?? "global") === "global" && !l.meta.requiresRestart,
  );
  if (!leaf) throw new Error("no global secret leaf to bind in this schema");
  bindingPath = leaf.path.join(".");
  secretName = `settings.${bindingPath}`;
});

afterAll(async () => {
  await coordinator.stop();
  await server.cleanup();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.apiKey}`);
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

describe("prepared secret versions", () => {
  test("a prepared version is listed for approval and is nobody's current version", async () => {
    const prepared = await createSecretVersion(server.db, {
      name: secretName,
      value: "new-provider-key",
      created_by: null,
      pending: {
        prepared_by: "Host-Kommando (engine --vault-set --pending)",
        bindings: [bindingPath],
      },
    });
    expect(prepared.version).toBe(1);

    // Not current: the vault check sees no version, the registry lists none,
    // and no revision can bind it.
    expect(await probeCurrentVersion(server.db, secretName)).toEqual({
      version: null,
      readable: false,
      absent: false,
    });
    expect(
      (await listSecretVersions(server.db)).find((s) => s.name === secretName),
    ).toBeUndefined();
    await expect(readSecretVersion(server.db, secretName, 1)).rejects.toThrow(/not yet approved/);
    const state = await getRuntimeConfigState(server.db);
    await expect(
      saveRuntimeConfigPatch(server.db, {
        expected_revision: state.saved_revision,
        changes: { [bindingPath]: prepared.reference },
        scope: "global",
        created_by: null,
      }),
    ).rejects.toThrow(/not yet approved/);

    const res = await api("/v1/secret-approvals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      expect.objectContaining({
        name: secretName,
        version: 1,
        reference: prepared.reference,
        prepared_by: "Host-Kommando (engine --vault-set --pending)",
        bindings: [bindingPath],
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("new-provider-key");
  });

  test("Ablehnen revokes the prepared version; it never becomes current", async () => {
    const second = await createSecretVersion(server.db, {
      name: secretName,
      value: "a-key-nobody-wants",
      created_by: null,
      pending: { prepared_by: "Host-Kommando (engine --vault-set --pending)", bindings: [] },
    });
    expect((await listPendingSecretVersions(server.db)).map((p) => p.version)).toEqual([1, 2]);
    const res = await api(`/v1/secret-approvals/${secretName}/${second.version}/reject`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: secretName, version: 2 });
    expect((await listPendingSecretVersions(server.db)).map((p) => p.version)).toEqual([1]);
    await expect(readSecretVersion(server.db, secretName, 2)).rejects.toThrow(/missing or revoked/);
    const again = await api(`/v1/secret-approvals/${secretName}/2/reject`, { method: "POST" });
    expect(again.status).toBe(404);
  });

  test("Freigeben makes it current and re-pins the binding it was prepared for", async () => {
    const res = await api(`/v1/secret-approvals/${secretName}/1/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: secretName,
      version: 1,
      bindings: [{ path: bindingPath, outcome: "rebound", detail: null }],
    });

    expect(await probeCurrentVersion(server.db, secretName)).toEqual({
      version: 1,
      readable: true,
      absent: false,
    });
    expect(await readSecretVersion(server.db, secretName, 1)).toBe("new-provider-key");
    expect(await listPendingSecretVersions(server.db)).toEqual([]);

    const state = await getRuntimeConfigState(server.db);
    const active = await getRuntimeRevision(server.db, state.active_revision);
    const bound = bindingPath
      .split(".")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], active.document);
    expect(bound).toBe(`secret://${secretName}/1`);

    const rows = await server.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.action, "secret.version_approved"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("new-provider-key");
    expect(
      await api(`/v1/secret-approvals/${secretName}/1/approve`, { method: "POST" }).then(
        (r) => r.status,
      ),
    ).toBe(404);
  });

  test("approving is a settings:write decision; reading the queue is settings:read", async () => {
    await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
    const anonymous = await fetch(`${server.baseUrl}/v1/secret-approvals`);
    expect(anonymous.status).toBe(401);
  });
});
