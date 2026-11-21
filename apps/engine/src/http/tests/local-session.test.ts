import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LAUNCH_SECRET_HEADER, LOCAL_WORKSPACE_PATHS } from "@shared/device/local-launch.ts";
import { and, eq, isNull } from "drizzle-orm";
import {
  apiKeys,
  connectors,
  engineSettings,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { LOCAL_OWNER_SETTING } from "../../identity/local-session.ts";
import type { LocalWorkspace } from "../../identity/local-workspace.ts";
import { BOOTSTRAP_COMPLETED_KEY } from "../../onboarding/bootstrap.ts";
import { createPowerState } from "../../scheduler/power-state.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const PORT = 47_321;
const HOST = `127.0.0.1:${PORT}`;
const SECRET = "l".repeat(43);
const DEVICE = { device_id: "5b2f6a51-8d0e-4c11-9f43-2f3a1c9d7e10", device_label: "MacBook Pro" };
const OWNER = { name: "Mike Bild", workspace_name: "Mike lokal" };
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

let server: HttpTestServer;
let local: TestDb;
let localApp: ReturnType<typeof createApp>;
let serverApp: ReturnType<typeof createApp>;
let counter = 0;

const POWER = createPowerState();

function workspace(launchSecret: string | null = SECRET): LocalWorkspace {
  return { preferredPort: PORT, port: PORT, launchSecret, power: POWER };
}

function signIn(
  app: ReturnType<typeof createApp>,
  body: unknown,
  opts: { host?: string; secret?: string | null; peer?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.host = opts.host ?? HOST;
  if (opts.secret !== null) headers[LAUNCH_SECRET_HEADER] = opts.secret ?? SECRET;
  return app.request(
    LOCAL_WORKSPACE_PATHS.session,
    { method: "POST", headers, body: JSON.stringify(body) },
    { incoming: { socket: { remoteAddress: opts.peer ?? "127.0.0.1" } } },
  );
}

function cookiePair(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

beforeAll(async () => {
  server = await createHttpTestServer("local_session_server");
  serverApp = createApp({ db: server.db, registry: buildDefaultRegistry(server.db) });
  local = await createTestDb("local_session_workspace");
  localApp = createApp({
    db: local.db,
    registry: buildDefaultRegistry(local.db),
    localWorkspace: workspace(),
  });
});

afterAll(async () => {
  await local.cleanup();
  await server.cleanup();
});

describe("server mode", () => {
  test("the local sign-in route does not exist", async () => {
    const response = await signIn(serverApp, { ...DEVICE, owner: OWNER });
    expect(response.status).toBe(404);
  });

  test("public capabilities stay available", async () => {
    const response = await serverApp.request(
      "/v1/identity/portal-tokens",
      { method: "POST", headers: { host: "subkit.example.test" } },
      LOOPBACK,
    );
    expect(response.status).toBe(401);
  });

  test("requests are not limited to the loopback host", async () => {
    const response = await serverApp.request(
      "/v1/setup",
      { headers: { host: "subkit.example.test" } },
      LOOPBACK,
    );
    expect(response.status).toBe(200);
  });
});

describe("local workspace mode", () => {
  test("every route answers 421 to another host", async () => {
    const paths = [
      ...new Set(
        localApp.routes
          .map((route) =>
            route.path.replaceAll(/:[A-Za-z_]+/g, "00000000-0000-4000-8000-000000000000"),
          )
          .filter((path) => !path.includes("*")),
      ),
    ];
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths.filter((_, index) => index % 7 === 0)) {
      for (const host of ["rebind.example.test:47321", "localhost:47321", "127.0.0.1:1"]) {
        const response = await localApp.request(path, { headers: { host } }, LOOPBACK);
        expect(`${path} ${host} ${response.status}`).toBe(`${path} ${host} 421`);
      }
    }
    const signInElsewhere = await signIn(
      localApp,
      { ...DEVICE, owner: OWNER },
      {
        host: `localhost:${PORT}`,
      },
    );
    expect(signInElsewhere.status).toBe(421);
  });

  test("a write from another origin is refused even on the right host", async () => {
    const response = await localApp.request(
      LOCAL_WORKSPACE_PATHS.session,
      {
        method: "POST",
        headers: {
          host: HOST,
          origin: "https://rebind.example.test",
          [LAUNCH_SECRET_HEADER]: SECRET,
        },
        body: JSON.stringify(DEVICE),
      },
      LOOPBACK,
    );
    expect(response.status).toBe(403);
  });

  test("capabilities that need a public address answer not_available_locally", async () => {
    for (const [method, path, capability] of [
      ["POST", "/v1/webhooks/inbound", "inbound_hooks"],
      ["POST", "/v1/identity/portal-tokens", "portal_tokens"],
      ["PUT", "/v1/cockpit/push-subscription", "push"],
    ] as const) {
      const response = await localApp.request(path, { method, headers: { host: HOST } }, LOOPBACK);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "not_available_locally", capability });
    }
  });

  test("sign-in waits until the launcher handed over the secret", async () => {
    const starting = createApp({
      db: local.db,
      registry: buildDefaultRegistry(local.db),
      localWorkspace: workspace(null),
    });
    const response = await signIn(starting, { ...DEVICE, owner: OWNER });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "launch_pending" });
  });

  test("the launcher defers background work on battery and resumes on mains power", async () => {
    const put = (body: unknown, secret: string | null = SECRET) =>
      localApp.request(
        "/v1/local-workspace/power",
        {
          method: "PUT",
          headers: {
            host: HOST,
            "content-type": "application/json",
            ...(secret ? { [LAUNCH_SECRET_HEADER]: secret } : {}),
          },
          body: JSON.stringify(body),
        },
        LOOPBACK,
      );
    expect((await put({ on_battery: true }, null)).status).toBe(401);
    expect(POWER.deferred()).toBe(false);
    const battery = await put({ on_battery: true });
    expect(battery.status).toBe(200);
    expect(await battery.json()).toEqual({ background_work: "deferred" });
    expect(POWER.deferred()).toBe(true);
    expect((await put({ on_battery: false, low_power_mode: true })).status).toBe(200);
    expect(POWER.deferred()).toBe(true);
    expect(await (await put({ on_battery: false })).json()).toEqual({ background_work: "running" });
    expect(POWER.deferred()).toBe(false);
    expect((await put({ on_battery: "yes" })).status).toBe(400);
    expect(
      (await serverApp.request("/v1/local-workspace/power", { method: "PUT" }, LOOPBACK)).status,
    ).toBe(404);
  });

  test("a peer outside loopback is refused", async () => {
    const response = await signIn(localApp, { ...DEVICE, owner: OWNER }, { peer: "192.168.1.20" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "loopback_only" });
  });

  test("a missing or wrong launch secret is refused", async () => {
    expect((await signIn(localApp, { ...DEVICE, owner: OWNER }, { secret: null })).status).toBe(
      401,
    );
    expect(
      (await signIn(localApp, { ...DEVICE, owner: OWNER }, { secret: "x".repeat(43) })).status,
    ).toBe(401);
  });

  test("the first sign-in needs the owner", async () => {
    const response = await signIn(localApp, DEVICE);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "owner_required" });
  });

  test("the first sign-in sets up the owner and mints an installation session", async () => {
    const response = await signIn(localApp, { ...DEVICE, owner: OWNER });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { installation_id: string; cockpit_path: string };
    expect(body).toMatchObject({ created: true, owner_created: true });
    expect(body.cockpit_path).toBe(`/cockpit/i/${body.installation_id}/`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`subkit_installation_${body.installation_id}=`);
    expect(cookie).toContain("HttpOnly");
    const [owner] = await local.db
      .select({ value: engineSettings.value })
      .from(engineSettings)
      .where(eq(engineSettings.key, LOCAL_OWNER_SETTING));
    const record = owner?.value as { tenant_id: string; user_id: string };
    const [user] = await local.db
      .select()
      .from(users)
      .where(and(eq(users.id, record.user_id), eq(users.tenant_id, record.tenant_id)));
    expect(user).toMatchObject({ display_name: "Mike Bild", status: "active" });
    const [completed] = await local.db
      .select({ value: engineSettings.value })
      .from(engineSettings)
      .where(eq(engineSettings.key, BOOTSTRAP_COMPLETED_KEY));
    expect(completed?.value).toBe(true);
    const liveKeys = await local.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, record.tenant_id), isNull(apiKeys.revoked_at)));
    expect(liveKeys).toHaveLength(0);
  });

  test("a later sign-in reuses the owner and the installation", async () => {
    const response = await signIn(localApp, DEVICE);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: false, owner_created: false });
  });

  test("the minted session approves a workflow and an API key still cannot", async () => {
    const signedIn = await signIn(localApp, DEVICE);
    const { installation_id } = (await signedIn.json()) as { installation_id: string };
    const cookie = cookiePair(signedIn);
    const api = `/cockpit/i/${installation_id}/api`;
    const browser = { host: HOST, cookie, "x-subkit-client": "cockpit" };
    const bootstrap = await localApp.request(
      `${api}/v1/cockpit/bootstrap`,
      { headers: browser },
      LOOPBACK,
    );
    expect(bootstrap.status).toBe(200);
    const { csrf_token, tenant, principal } = (await bootstrap.json()) as {
      csrf_token: string;
      tenant: { id: string };
      principal: { id: string; display_name: string };
    };
    expect(principal.display_name).toBe("Mike Bild");

    const slug = `local-approval-${++counter}`;
    const [connector] = await local.db
      .insert(connectors)
      .values({
        tenant_id: tenant.id,
        slug,
        display_name: slug,
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://example.test/api",
      })
      .returning();
    const [workflow] = await local.db
      .insert(workflows)
      .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "draft" })
      .returning();
    if (!connector || !workflow) throw new Error("missing workflow fixture");
    const [version] = await local.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: slug,
          steps: [
            {
              id: "send",
              kind: "request",
              connector_id: connector.id,
              method: "POST",
              path: "/messages",
              body: { recipient: "reviewed@example.test" },
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("missing version fixture");

    const base = `${api}/v1/workflows/${workflow.id}`;
    const preview = await localApp.request(
      `${base}/versions/${version.id}/authority-preview`,
      { headers: browser },
      LOOPBACK,
    );
    expect(preview.status).toBe(200);
    const shape = (await preview.json()) as {
      digest: string;
      suggested_bounds: Record<string, unknown>;
    };
    const grant = JSON.stringify({
      workflow_version_id: version.id,
      execution_environment: "dev",
      expected_manifest_digest: shape.digest,
      ...shape.suggested_bounds,
    });

    const token = `wf_live_${String(++counter).padStart(4, "0")}_local_owner_machine_key`;
    await local.db.insert(apiKeys).values({
      tenant_id: tenant.id,
      user_id: principal.id,
      prefix: token.slice(0, 12),
      token_sha256: createHash("sha256").update(token).digest("hex"),
      scopes: ["*"],
    });
    const machine = await localApp.request(
      `/v1/workflows/${workflow.id}/execution-authorities`,
      {
        method: "POST",
        headers: {
          host: HOST,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: grant,
      },
      LOOPBACK,
    );
    expect(machine.status).toBe(403);
    expect(await machine.json()).toMatchObject({ code: "human_session_required" });

    const withoutCsrf = await localApp.request(
      `${base}/execution-authorities`,
      { method: "POST", headers: { ...browser, "content-type": "application/json" }, body: grant },
      LOOPBACK,
    );
    expect(withoutCsrf.status).toBe(403);

    const granted = await localApp.request(
      `${base}/execution-authorities`,
      {
        method: "POST",
        headers: { ...browser, "content-type": "application/json", "x-subkit-csrf": csrf_token },
        body: grant,
      },
      LOOPBACK,
    );
    expect(granted.status).toBe(201);
    expect(await granted.json()).toMatchObject({ state: "approved" });
  });

  test("an engine whose database already holds a server workspace refuses local sign-in", async () => {
    const adopting = createApp({
      db: server.db,
      registry: buildDefaultRegistry(server.db),
      localWorkspace: workspace(),
    });
    const response = await signIn(adopting, { ...DEVICE, owner: OWNER });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "not_local_workspace" });
  });
});
