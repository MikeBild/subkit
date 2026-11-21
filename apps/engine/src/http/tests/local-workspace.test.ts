import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LAUNCH_SECRET_HEADER, LOCAL_WORKSPACE_PATHS } from "@shared/device/local-launch.ts";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../../config/loader.ts";
import { auditLog, engineSettings } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { ensureLocalOwner, storeLocalAiAccess } from "../../identity/index.ts";
import { LOCAL_OWNER_SETTING } from "../../identity/local-session.ts";
import type { LocalWorkspace } from "../../identity/local-workspace.ts";
import { createPowerState } from "../../scheduler/power-state.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const PORT = 47_322;
const HOST = `127.0.0.1:${PORT}`;
const SECRET = "w".repeat(43);
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

let server: HttpTestServer;
let local: TestDb;
let localApp: ReturnType<typeof createApp>;
let serverApp: ReturnType<typeof createApp>;

function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body: unknown,
  secret: string | null = SECRET,
) {
  return app.request(
    path,
    {
      method,
      headers: {
        host: HOST,
        "content-type": "application/json",
        ...(secret ? { [LAUNCH_SECRET_HEADER]: secret } : {}),
      },
      body: JSON.stringify(body),
    },
    LOOPBACK,
  );
}

beforeAll(async () => {
  server = await createHttpTestServer("local_workspace_server");
  serverApp = createApp({ db: server.db, registry: buildDefaultRegistry(server.db) });
  local = await createTestDb("local_workspace_routes");
  const workspace: LocalWorkspace = {
    preferredPort: PORT,
    port: PORT,
    launchSecret: SECRET,
    power: createPowerState(),
  };
  localApp = createApp({
    db: local.db,
    registry: buildDefaultRegistry(local.db),
    localWorkspace: workspace,
  });
});

afterAll(async () => {
  await local.cleanup();
  await server.cleanup();
});

describe("server mode", () => {
  test("the launcher routes of a local workspace do not exist", async () => {
    expect((await call(serverApp, "POST", LOCAL_WORKSPACE_PATHS.move_to_server, {})).status).toBe(
      404,
    );
    expect(
      (await call(serverApp, "PUT", LOCAL_WORKSPACE_PATHS.workers, { paused: true })).status,
    ).toBe(404);
    expect((await call(serverApp, "PUT", LOCAL_WORKSPACE_PATHS.ai_access, {})).status).toBe(404);
  });
});

describe("local workspace mode", () => {
  test("the launcher routes need the launch secret and an owner", async () => {
    const body = { server_origin: "https://subkit.example.test" };
    expect(
      (await call(localApp, "POST", LOCAL_WORKSPACE_PATHS.move_to_server, body, null)).status,
    ).toBe(401);
    const early = await call(localApp, "POST", LOCAL_WORKSPACE_PATHS.move_to_server, body);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: "owner_required" });
  });

  test("a model server outside this device is refused, one on loopback is stored", async () => {
    const signedIn = await call(localApp, "POST", LOCAL_WORKSPACE_PATHS.session, {
      device_id: "5b2f6a51-8d0e-4c11-9f43-2f3a1c9d7e10",
      device_label: "MacBook Pro",
      owner: { name: "Mike Bild" },
    });
    expect(signedIn.status).toBe(200);
    expect(
      (await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.ai_access, { kind: "x" })).status,
    ).toBe(400);
    const remote = await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.ai_access, {
      kind: "model_server",
      origin: "http://192.168.1.4:11434",
    });
    expect(remote.status).toBe(422);
    const stored = await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.ai_access, {
      kind: "model_server",
      origin: "http://localhost:11434",
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      kind: "model_server",
      origin: "http://localhost:11434",
    });
    expect(getConfig().llm.providers.openai.base_url).toBe("http://localhost:11434/v1");
  });

  test("moving to a server writes the export bundle and audits the move", async () => {
    expect(
      (await call(localApp, "POST", LOCAL_WORKSPACE_PATHS.move_to_server, { server_origin: "x" }))
        .status,
    ).toBe(400);
    const response = await call(localApp, "POST", LOCAL_WORKSPACE_PATHS.move_to_server, {
      server_origin: "https://subkit.example.test",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    const [owner] = await local.db
      .select({ value: engineSettings.value })
      .from(engineSettings)
      .where(eq(engineSettings.key, LOCAL_OWNER_SETTING));
    const tenantId = (owner?.value as { tenant_id: string } | undefined)?.tenant_id ?? "";
    const rows = await local.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "workspace.moved_to_server")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      server_host: "subkit.example.test",
      file_id: response.headers.get("x-subkit-file-id"),
    });
  });

  test("a provider key is checked first and stored for the local workspace only when accepted", async () => {
    const owner = await ensureLocalOwner(local.db, undefined);
    if (!owner.ok) throw new Error("expected the local owner");
    const refused = await storeLocalAiAccess(
      local.db,
      owner,
      { kind: "provider", provider: "anthropic", api_key: "sk-ant-refused" },
      async () => ({ ok: false, model: null, code: "key_rejected", reason: "401" }),
    );
    expect(refused).toEqual({ ok: false, code: "llm_key_rejected" });
    expect(getConfig(owner.tenant_id).llm.providers.anthropic.api_key).not.toBe("sk-ant-refused");
    const accepted = await storeLocalAiAccess(
      local.db,
      owner,
      { kind: "provider", provider: "anthropic", api_key: "sk-ant-accepted" },
      async () => ({ ok: true, model: "claude" }),
    );
    expect(accepted).toEqual({ ok: true });
    const llm = getConfig(owner.tenant_id).llm;
    expect(llm.provider).toBe("anthropic");
    expect(llm.providers.anthropic.api_key).toBe("sk-ant-accepted");
    const audited = await local.db
      .select({ resource_id: auditLog.resource_id, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, owner.tenant_id), eq(auditLog.action, "settings.changed")));
    const key = audited.find((row) => row.resource_id === "llm.api_key");
    expect(JSON.stringify(key?.after)).not.toContain("sk-ant-accepted");
  });

  test("the launcher reads active runs and switches the workers", async () => {
    const get = await localApp.request(
      LOCAL_WORKSPACE_PATHS.activity,
      { headers: { host: HOST, [LAUNCH_SECRET_HEADER]: SECRET } },
      LOOPBACK,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ active_runs: 0, workers_paused: false });
    expect(
      (await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.workers, { paused: "yes" })).status,
    ).toBe(400);
    expect(
      (await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.workers, { paused: true }, null)).status,
    ).toBe(401);
    const paused = await call(localApp, "PUT", LOCAL_WORKSPACE_PATHS.workers, { paused: true });
    expect(await paused.json()).toEqual({ paused: false });
  });
});
