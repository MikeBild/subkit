import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import { and, eq } from "drizzle-orm";
import {
  issueBrowserSession,
  signBrowserCsrf,
  verifyBrowserSession,
} from "../../auth/browser-session.ts";
import { auditLog, deviceAllowances, deviceRunners } from "../../db/schema/index.ts";
import { createOrReuseDesktopInstallation } from "../../identity/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
} from "../tests/setup.ts";

let server: HttpTestServer;

const SIGN_IN_ROUTES = new Set(["POST /v1/identity/cli-session"]);
let nonceCounter = 0;

beforeAll(async () => {
  server = await createHttpTestServer("devices");
});

afterAll(async () => {
  if (server) await server.cleanup();
});

const DEVICE_IDS = {
  Laptop: "d1000000-0000-4000-8000-000000000001",
  Studio: "d1000000-0000-4000-8000-000000000002",
  Spare: "d1000000-0000-4000-8000-000000000003",
  Revoked: "d1000000-0000-4000-8000-000000000004",
  Cascade: "d1000000-0000-4000-8000-000000000005",
  Here: "d1000000-0000-4000-8000-000000000006",
  There: "d1000000-0000-4000-8000-000000000007",
} as const;

function nonce(): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(++nonceCounter, 12);
  return bytes.toString("base64url");
}

async function desktopSession(label: keyof typeof DEVICE_IDS) {
  const { installation } = await createOrReuseDesktopInstallation(
    server.db,
    server.tenantId,
    server.userId,
    { device_id: DEVICE_IDS[label], device_label: `${label} (Mike)` },
  );
  const issued = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    installationId: installation.id,
    redirectTo: `/cockpit/i/${installation.id}/`,
    via: "desktop_login",
  });
  const cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const payload = await verifyBrowserSession(
    decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)),
  );
  if (!payload) throw new Error("desktop session was not issued");
  return {
    installation_id: installation.id,
    api: `${server.baseUrl}/cockpit/i/${installation.id}/api`,
    headers: {
      cookie,
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    },
  };
}

interface Runner {
  device_runner_id: string;
  privateKey: KeyObject;
  session: Awaited<ReturnType<typeof desktopSession>>;
}

async function enroll(label: keyof typeof DEVICE_IDS): Promise<Runner> {
  const session = await desktopSession(label);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const response = await fetch(`${session.api}/v1/devices/runner/enroll`, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
      runner_version: "11.3.0",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { device_runner_id: string; device_label: string };
  expect(body.device_label).toBe(`${label} (Mike)`);
  return { device_runner_id: body.device_runner_id, privateKey, session };
}

function assertion(
  runner: Pick<Runner, "device_runner_id">,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    aud: RUNNER_ASSERTION_AUDIENCE,
    device_runner_id: runner.device_runner_id,
    iat: new Date(Date.now()).toISOString(), // allow-wall-clock: the server checks iat against its own clock
    nonce: nonce(),
    ...overrides,
  });
}

async function exchange(text: string, key: KeyObject): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/device-runner/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion: text,
      signature: sign(null, Buffer.from(text), key).toString("base64url"),
    }),
  });
}

async function token(runner: Runner): Promise<string> {
  const response = await exchange(assertion(runner), runner.privateKey);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; expires_at: string };
  const lifetime = Date.parse(body.expires_at) - Date.now(); // allow-wall-clock: token lifetime
  expect(lifetime).toBeGreaterThan(9 * 60_000);
  expect(lifetime).toBeLessThanOrEqual(10 * 60_000);
  return body.access_token;
}

function runnerPost(path: string, accessToken: string, body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const heartbeat = (generation: number) => ({
  runner_version: "11.3.0",
  os: "darwin",
  capabilities: ["files"],
  personal: [],
  permissions: {},
  allowances_digest: "x",
  generation,
});

async function auditRows(action: string, device_id: string) {
  return server.db
    .select({ metadata: auditLog.metadata, reason: auditLog.reason })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, action as never),
        eq(auditLog.resource_id, device_id),
      ),
    );
}

describe("enrolling a device runner", () => {
  test("only the desktop session of that device enrolls, and the enrollment is audited", async () => {
    const runner = await enroll("Laptop");
    expect(await auditRows("device_runner.enrolled", runner.device_runner_id)).toHaveLength(1);
    const browser = await browserSessionHeaders(server, server.userId);
    const fromBrowser = await fetch(`${server.baseUrl}/v1/devices/runner/enroll`, {
      method: "POST",
      headers: browser,
      body: JSON.stringify({
        public_key: generateKeyPairSync("ed25519").publicKey.export({
          type: "spki",
          format: "pem",
        }),
      }),
    });
    expect(fromBrowser.status).toBe(403);
    expect(((await fromBrowser.json()) as { code: string }).code).toBe("desktop_session_required");
    const withKey = await fetch(`${server.baseUrl}/v1/devices/runner/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ public_key: "x" }),
    });
    expect(withKey.status).toBe(403);
  });

  test("a key that is not Ed25519 is refused", async () => {
    const session = await desktopSession("Spare");
    const response = await fetch(`${session.api}/v1/devices/runner/enroll`, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({
        public_key: generateKeyPairSync("ec", { namedCurve: "P-256" })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("public_key_invalid");
  });
});

describe("the runner's own credential", () => {
  test("a signed assertion becomes a short token; replay, audience, skew and forgery are refused", async () => {
    const runner = await enroll("Studio");
    await token(runner);
    const once = assertion(runner);
    expect((await exchange(once, runner.privateKey)).status).toBe(200);
    const replay = await exchange(once, runner.privateKey);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe("assertion_replayed");
    const wrongAudience = await exchange(assertion(runner, { aud: "cockpit" }), runner.privateKey);
    expect(((await wrongAudience.json()) as { code: string }).code).toBe(
      "assertion_wrong_audience",
    );
    const stale = await exchange(
      assertion(runner, { iat: new Date(Date.now() - 61_000).toISOString() }), // allow-wall-clock: skew window
      runner.privateKey,
    );
    expect(((await stale.json()) as { code: string }).code).toBe("assertion_out_of_time");
    const forged = await exchange(assertion(runner), generateKeyPairSync("ed25519").privateKey);
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as { code: string }).code).toBe("assertion_signature_invalid");
  });

  test("the runner token never reaches a route outside the runner channel", async () => {
    const runner = await enroll("Laptop");
    const accessToken = await token(runner);
    const spec = (await (await fetch(`${server.baseUrl}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const outside = Object.entries(spec.paths)
      .filter(([path]) => !path.startsWith("/v1/device-runner/"))
      .flatMap(([path, methods]) =>
        Object.keys(methods)
          .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
          .map((method) => ({
            method: method.toUpperCase(),
            path: path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000"),
          })),
      );
    expect(outside.length).toBeGreaterThan(100);
    outside.push(
      { method: "POST", path: "/mcp" },
      { method: "GET", path: "/v1/cockpit/events/stream" },
      {
        method: "POST",
        path: `/cockpit/i/${runner.session.installation_id}/api/v1/device-runner/heartbeat`,
      },
    );
    const leaked: string[] = [];
    for (const route of outside) {
      const response = await fetch(`${server.baseUrl}${route.path}`, {
        method: route.method,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        ...(route.method === "GET" || route.method === "DELETE" ? {} : { body: "{}" }),
      });
      const expected = SIGN_IN_ROUTES.has(`${route.method} ${route.path}`) ? 401 : 403;
      if (response.status !== expected)
        leaked.push(`${route.method} ${route.path} ${response.status}`);
      else await response.body?.cancel();
    }
    expect(leaked).toEqual([]);
    const approve = await fetch(
      `${server.baseUrl}/v1/workflows/00000000-0000-4000-8000-000000000000/authorities`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(approve.status).toBe(403);
    expect(((await approve.json()) as { code: string }).code).toBe("device_runner_scope");
  });

  test("a revoked device gets 403 for its token and its credential", async () => {
    const runner = await enroll("Revoked");
    const accessToken = await token(runner);
    const browser = await browserSessionHeaders(server, server.userId);
    const revoked = await fetch(`${server.baseUrl}/v1/devices/${runner.device_runner_id}`, {
      method: "DELETE",
      headers: browser,
    });
    expect(revoked.status).toBe(204);
    expect((await exchange(assertion(runner), runner.privateKey)).status).toBe(403);
    const stop = await runnerPost("/v1/device-runner/stop", accessToken, {
      generation: 1,
      stopped_at: new Date(Date.now()).toISOString(), // allow-wall-clock: stop instant
    });
    expect(stop.status).toBe(403);
    expect(await auditRows("device_runner.revoked", runner.device_runner_id)).toHaveLength(1);
  });

  test("signing out the desktop installation revokes its runner in the same step", async () => {
    const runner = await enroll("Cascade");
    const browser = await browserSessionHeaders(server, server.userId);
    const signedOut = await fetch(
      `${server.baseUrl}/v1/cockpit/installations/${runner.session.installation_id}`,
      { method: "DELETE", headers: browser },
    );
    expect(signedOut.status).toBe(204);
    const [row] = await server.db
      .select({ revoked_reason: deviceRunners.revoked_reason })
      .from(deviceRunners)
      .where(
        and(
          eq(deviceRunners.tenant_id, server.tenantId),
          eq(deviceRunners.id, runner.device_runner_id),
        ),
      );
    expect(row?.revoked_reason).toBe("installation_revoked");
    expect((await exchange(assertion(runner), runner.privateKey)).status).toBe(403);
  });
});

describe("heartbeat and stop", () => {
  test("the stop generation only rises, a stop is recorded once, and devices stay apart", async () => {
    const laptop = await enroll("Laptop");
    const studio = await enroll("Studio");
    const laptopToken = await token(laptop);
    const studioToken = await token(studio);
    const first = await runnerPost("/v1/device-runner/heartbeat", laptopToken, heartbeat(2));
    expect(await first.json()).toEqual({ stop_generation: 2 });
    const lower = await runnerPost("/v1/device-runner/heartbeat", laptopToken, heartbeat(1));
    expect(await lower.json()).toEqual({ stop_generation: 2 });
    const report = { generation: 3, stopped_at: new Date(Date.now()).toISOString() }; // allow-wall-clock: stop instant
    const stopped = await runnerPost("/v1/device-runner/stop", laptopToken, report);
    expect(await stopped.json()).toEqual({ stop_generation: 3, recorded: true });
    const again = await runnerPost("/v1/device-runner/stop", laptopToken, report);
    expect(await again.json()).toEqual({ stop_generation: 3, recorded: false });
    const older = await runnerPost("/v1/device-runner/stop", laptopToken, {
      ...report,
      generation: 1,
    });
    expect(await older.json()).toEqual({ stop_generation: 3, recorded: false });
    expect(await auditRows("device.stop", laptop.device_runner_id)).toHaveLength(1);
    const studioBeat = await runnerPost("/v1/device-runner/heartbeat", studioToken, heartbeat(0));
    expect(await studioBeat.json()).toEqual({ stop_generation: 0 });
    const list = (await (
      await fetch(`${server.baseUrl}/v1/devices`, {
        headers: await browserSessionHeaders(server, server.userId),
      })
    ).json()) as { items: { id: string; online: boolean }[] };
    expect(list.items.find((item) => item.id === laptop.device_runner_id)?.online).toBe(true);
  });

  test("a browser session or an API key cannot report for a device", async () => {
    const browser = await browserSessionHeaders(server, server.userId);
    const response = await fetch(`${server.baseUrl}/v1/device-runner/heartbeat`, {
      method: "POST",
      headers: browser,
      body: JSON.stringify(heartbeat(9)),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("device_runner_required");
  });
});

describe("allowances live with the device", () => {
  const folder = {
    kind: "folder",
    id: "f-rechnungen",
    display: "~/Documents/Rechnungen",
    access: "read",
    digest: "a".repeat(64),
    entered_by: "person",
  };

  test("only that device's own session mirrors them, and each change is audited", async () => {
    const laptop = await enroll("Laptop");
    const studio = await desktopSession("Studio");
    const path = `/v1/devices/${laptop.device_runner_id}/allowances`;
    const mirrored = await fetch(`${laptop.session.api}${path}`, {
      method: "PUT",
      headers: laptop.session.headers,
      body: JSON.stringify({ allowances: [folder] }),
    });
    expect(await mirrored.json()).toEqual({ added: 1, removed: 0 });
    const widened = await fetch(`${laptop.session.api}${path}`, {
      method: "PUT",
      headers: laptop.session.headers,
      body: JSON.stringify({ allowances: [{ ...folder, access: "write" }] }),
    });
    expect(await widened.json()).toEqual({ added: 1, removed: 1 });
    expect(await auditRows("device.folder_allowed", laptop.device_runner_id)).toHaveLength(2);
    expect(await auditRows("device.folder_removed", laptop.device_runner_id)).toHaveLength(1);
    const elsewhere = await fetch(`${studio.api}${path}`, {
      method: "PUT",
      headers: studio.headers,
      body: JSON.stringify({ allowances: [] }),
    });
    expect(elsewhere.status).toBe(403);
    expect(((await elsewhere.json()) as { code: string }).code).toBe("device_session_required");
    const runnerToken = await token(laptop);
    const fromRunner = await fetch(`${server.baseUrl}${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ allowances: [] }),
    });
    expect(fromRunner.status).toBe(403);
    const rows = await server.db
      .select({ access: deviceAllowances.access })
      .from(deviceAllowances)
      .where(
        and(
          eq(deviceAllowances.tenant_id, server.tenantId),
          eq(deviceAllowances.device_runner_id, laptop.device_runner_id),
        ),
      );
    expect(rows.map((row) => row.access).sort()).toEqual(["read", "write"]);
    const read = await fetch(`${server.baseUrl}${path}`, {
      headers: await browserSessionHeaders(server, server.userId),
    });
    expect(((await read.json()) as { items: { access: string }[] }).items).toEqual([
      expect.objectContaining({ access: "write" }),
    ]);
  });

  test("a private site counts only when the person entered it", async () => {
    const laptop = await enroll("Laptop");
    const response = await fetch(
      `${laptop.session.api}/v1/devices/${laptop.device_runner_id}/allowances`,
      {
        method: "PUT",
        headers: laptop.session.headers,
        body: JSON.stringify({
          allowances: [
            {
              kind: "site",
              id: "router",
              origin: "http://192.168.1.1",
              private: true,
              digest: "b".repeat(64),
              entered_by: "approval",
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("private_site_needs_person");
  });
});

describe("the device list knows the asking installation", () => {
  test("only the device of the asking desktop session is marked as this installation", async () => {
    const here = await enroll("Here");
    const there = await enroll("There");
    const fromHere = await fetch(`${here.session.api}/v1/devices`, {
      headers: here.session.headers,
    });
    expect(fromHere.status).toBe(200);
    const listed = (
      (await fromHere.json()) as {
        items: { id: string; is_this_installation: boolean; installation_id?: string }[];
      }
    ).items;
    expect(listed.find((item) => item.id === here.device_runner_id)?.is_this_installation).toBe(
      true,
    );
    expect(listed.find((item) => item.id === there.device_runner_id)?.is_this_installation).toBe(
      false,
    );
    expect(listed.some((item) => "installation_id" in item)).toBe(false);
    const byKey = await fetch(`${server.baseUrl}/v1/devices`, {
      headers: { authorization: `Bearer ${server.apiKey}` },
    });
    const keyed = ((await byKey.json()) as { items: { is_this_installation: boolean }[] }).items;
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((item) => !item.is_this_installation)).toBe(true);
  });
});

describe("devices of other people and workspaces", () => {
  test("another workspace never sees or revokes a device", async () => {
    const laptop = await enroll("Laptop");
    const other = await createSecondaryTenant(server, "devices-other");
    const list = await fetch(`${server.baseUrl}/v1/devices?scope=all`, {
      headers: { authorization: `Bearer ${other.admin.apiKey}` },
    });
    const body = (await list.json()) as { items?: { id: string }[] };
    expect((body.items ?? []).some((item) => item.id === laptop.device_runner_id)).toBe(false);
    const revoke = await fetch(`${server.baseUrl}/v1/devices/${laptop.device_runner_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${other.admin.apiKey}` },
    });
    expect(revoke.status).toBe(404);
  });
});
