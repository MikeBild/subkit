import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { AuditAction } from "../../../audit/index.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../../config/loader.ts";
import { auditLog } from "../../../db/schema/audit.ts";
import { apiKeys } from "../../../db/schema/identity.ts";
import {
  engineRestartRequests,
  runtimeConfigReplicas,
  runtimeConfigState,
} from "../../../db/schema/index.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import {
  bootIdentity,
  recordRestartOutcomeAtBoot,
  registerRestartTrigger,
} from "../../../runtime-config/restart.ts";
import { initializeRuntimeConfig } from "../../../runtime-config/service.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

const PREVIOUS_BOOT_ID = "00000000-0000-4000-8000-0000000b0071";

let server: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let configDir: string;
let previousMasterKey: string | undefined;

beforeAll(async () => {
  previousMasterKey = testEnv.MASTER_KEY;
  testEnv.MASTER_KEY = "33".repeat(32);
  testEnv.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "sk-system-restart-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/system-restart", NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  server = await createHttpTestServer("system-restart-route");
  await initializeRuntimeConfig(server.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(server.db, "test", "restart-replica");
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

function call(path: string, init: RequestInit = {}, key = server.apiKey): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function scopedKey(suffix: string, scopes: string[]): Promise<string> {
  const plaintext = `wf_live_${suffix}_restart_${"0".repeat(40 - suffix.length)}`;
  await server.db.insert(apiKeys).values({
    tenant_id: server.tenantId,
    user_id: server.userId,
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes,
  });
  return plaintext;
}

interface Status {
  boot_id: string;
  started_at: string;
  saved_revision: number;
  active_revision: number;
  activation_status: string;
  restart_supervised: boolean;
  pending_restart_fields: string[];
}

async function status(): Promise<Status> {
  const response = await call("/v1/system/restart-status");
  expect(response.status).toBe(200);
  return (await response.json()) as Status;
}

async function saveAndActivate(changes: Record<string, unknown>) {
  const current = await status();
  const saved = await call("/v1/settings", {
    method: "PATCH",
    body: JSON.stringify({ expected_revision: current.saved_revision, changes, scope: "global" }),
  });
  expect(saved.status).toBe(200);
  const body = (await saved.json()) as { saved_revision: number; pending_restart_fields: string[] };
  const activated = await call(`/v1/settings/revisions/${body.saved_revision}/activate`, {
    method: "POST",
  });
  expect(activated.status).toBe(200);
  return (await activated.json()) as { activation_status: string };
}

async function restart(key = server.apiKey) {
  const response = await call("/v1/system/restart", { method: "POST" }, key);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("POST /v1/system/restart and GET /v1/system/restart-status", () => {
  test("status needs authentication and settings:read and names this process", async () => {
    expect((await fetch(`${server.baseUrl}/v1/system/restart-status`)).status).toBe(401);
    const restartOnly = await scopedKey("only", ["system:restart"]);
    expect((await call("/v1/system/restart-status", {}, restartOnly)).status).toBe(403);

    const body = await status();
    expect(body).toMatchObject({
      boot_id: bootIdentity().id,
      started_at: bootIdentity().started_at.toISOString(),
      active_revision: body.saved_revision,
      activation_status: "active",
      restart_supervised: false,
      pending_restart_fields: [],
    });
    const health = (await (await fetch(`${server.baseUrl}/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).not.toHaveProperty("boot_id");
  });

  test("a restart needs system:restart; settings:write is not enough", async () => {
    const writer = await scopedKey("wrtr", ["settings:read", "settings:write"]);
    expect((await restart(writer)).status).toBe(403);
  });

  test("refuses honestly: not_supervised, then multiple_replicas", async () => {
    expect((await saveAndActivate({ "server.port": 3101 })).activation_status).toBe(
      "restart_required",
    );
    const unsupervised = await restart();
    expect(unsupervised.status).toBe(409);
    expect(unsupervised.body.code).toBe("not_supervised");
    expect(String(unsupervised.body.hint)).toContain("systemctl restart subkit-engine");

    expect((await saveAndActivate({ "server.restart_supervised": true })).activation_status).toBe(
      "restart_required",
    );
    const waiting = await status();
    expect(waiting.restart_supervised).toBe(true);
    expect(waiting.pending_restart_fields).toEqual(["server.port"]);
    expect(getConfig().server.port).not.toBe(3101);

    await server.db.insert(runtimeConfigReplicas).values({
      instance_id: "other-live-replica",
      product_version: "test",
      last_seen_at: sql`now()`,
    });
    try {
      const multiple = await restart();
      expect(multiple.status).toBe(409);
      expect(multiple.body.code).toBe("multiple_replicas");
    } finally {
      await server.db
        .delete(runtimeConfigReplicas)
        .where(eq(runtimeConfigReplicas.instance_id, "other-live-replica"));
    }
  });

  test("refuses while no process restart is registered, and writes nothing", async () => {
    const early = await restart();
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("not_ready");
    const requested = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, AuditAction.ENGINE_RESTART_REQUESTED),
        ),
      );
    expect(requested).toHaveLength(0);
  });

  test("accepts once, answers 202 before the process restart runs, and audits the request", async () => {
    let triggered = 0;
    const unregister = registerRestartTrigger(() => {
      triggered += 1;
    });
    try {
      const accepted = await restart();
      expect(accepted.status).toBe(202);
      expect(accepted.body.boot_id).toBe(bootIdentity().id);
      expect(triggered).toBe(0);
      for (let attempt = 0; attempt < 50 && triggered === 0; attempt += 1) await Bun.sleep(20);
      expect(triggered).toBe(1);

      const [requested] = await server.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, server.tenantId),
            eq(auditLog.action, AuditAction.ENGINE_RESTART_REQUESTED),
          ),
        );
      expect(requested).toMatchObject({
        id: accepted.body.audit_id,
        resource_type: "engine",
        resource_id: accepted.body.request_id,
        actor_type: "user",
      });

      const again = await restart();
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("restart_in_progress");
      expect(triggered).toBe(1);

      await coordinator.stop();
      const [stored] = await server.db.select().from(engineRestartRequests);
      const request = stored?.request;
      if (!request) throw new Error("restart request was not persisted");
      await server.db
        .update(engineRestartRequests)
        .set({ request: { ...request, from_boot_id: PREVIOUS_BOOT_ID } })
        .where(eq(engineRestartRequests.key, "engine"));
      await initializeRuntimeConfig(server.db, getConfig());
      expect(getConfig().server.port).toBe(3101);
      expect(await recordRestartOutcomeAtBoot(server.db)).toEqual({
        outcome: "completed",
        request_id: String(accepted.body.request_id),
      });
      expect(await recordRestartOutcomeAtBoot(server.db)).toBeNull();
      const [completed] = await server.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, server.tenantId),
            eq(auditLog.action, AuditAction.ENGINE_RESTART_COMPLETED),
          ),
        );
      expect(completed).toMatchObject({
        resource_id: accepted.body.request_id,
        actor_type: "system",
        result: "success",
      });
      expect(completed?.metadata).toMatchObject({ requested_audit_id: accepted.body.audit_id });

      coordinator = new RuntimeConfigCoordinator(server.db, "test", "restart-replica");
      await coordinator.start();
      const after = await status();
      expect(after.active_revision).toBe(after.saved_revision);
      expect(after.pending_restart_fields).toEqual([]);
      const nothing = await restart();
      expect(nothing.status).toBe(409);
      expect(nothing.body.code).toBe("nothing_pending");
    } finally {
      unregister();
    }
  });

  test("a restart that did not activate the waiting revision is recorded as failed", async () => {
    const [state] = await server.db.select().from(runtimeConfigState);
    const [stored] = await server.db.select().from(engineRestartRequests);
    if (!stored || !state?.active_revision) throw new Error("no prior request");
    const { outcome: _outcome, closed_at: _closed, to_boot_id: _to, ...open } = stored.request;
    await server.db
      .update(engineRestartRequests)
      .set({
        request: {
          ...open,
          request_id: "00000000-0000-4000-8000-00000000f41d",
          from_boot_id: "00000000-0000-4000-8000-0000000b0072",
          expected_revision: state.active_revision + 1,
        },
      })
      .where(eq(engineRestartRequests.key, "engine"));
    const answered = await recordRestartOutcomeAtBoot(server.db);
    expect(answered?.outcome).toBe("failed");
    const [failed] = await server.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, AuditAction.ENGINE_RESTART_FAILED),
        ),
      );
    expect(failed).toMatchObject({ resource_id: answered?.request_id, result: "error" });
  });
});
