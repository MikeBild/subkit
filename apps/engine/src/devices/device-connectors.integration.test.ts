import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq, like } from "drizzle-orm";
import { connectors, tenants } from "../db/schema/index.ts";
import {
  call,
  enroll,
  heartbeat,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { ensureDeviceConnectors } from "./device-connectors.ts";
import { revokeDevice } from "./registry.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_connectors");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

async function deviceConnectors(device_id: string) {
  return server.db
    .select({
      slug: connectors.slug,
      display_name: connectors.display_name,
      driver: connectors.driver,
      environment: connectors.environment,
      auth_type: connectors.auth_type,
      config: connectors.config,
      enabled: connectors.enabled,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, server.tenantId),
        like(connectors.slug, `device-${device_id}-%`),
      ),
    )
    .orderBy(asc(connectors.slug), asc(connectors.environment));
}

test("a device gets one connector per capability that is on, once, and loses them on revoke", async () => {
  const runner = await enroll("Studio (Mike)");
  expect(await deviceConnectors(runner.device_id)).toEqual([]);

  const beat = (capabilities: string[], language = "de") =>
    fetch(`${server.baseUrl}/v1/device-runner/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runner.token}`,
        "content-type": "application/json",
        "accept-language": language,
      },
      body: JSON.stringify({ ...heartbeat(0), capabilities }),
    });
  expect((await beat(["files"])).status).toBe(200);
  const files = await deviceConnectors(runner.device_id);
  expect(files).toEqual(
    (["dev", "prod"] as const).map((environment) => ({
      slug: `device-${runner.device_id}-files`,
      display_name: "Studio (Mike): Dateien",
      driver: "local_files",
      environment,
      auth_type: "none",
      config: { device_id: runner.device_id },
      enabled: true,
    })),
  );

  expect((await beat(["files"], "en")).status).toBe(200);
  expect(
    await ensureDeviceConnectors(
      server.db,
      { tenant_id: server.tenantId, device_id: runner.device_id },
      "en",
    ),
  ).toBe(0);
  expect(await deviceConnectors(runner.device_id)).toHaveLength(2);

  expect((await beat(["files", "browser"], "en")).status).toBe(200);
  const both = await deviceConnectors(runner.device_id);
  expect(both.map((row) => `${row.display_name}/${row.environment}`)).toEqual([
    "Studio (Mike): Browser/dev",
    "Studio (Mike): Browser/prod",
    "Studio (Mike): Dateien/dev",
    "Studio (Mike): Dateien/prod",
  ]);

  expect(
    await revokeDevice(
      server.db,
      { tenant_id: server.tenantId, user_id: server.userId, may_revoke_any: false } as never,
      runner.device_id,
    ),
  ).toBe(true);
  const revoked = await deviceConnectors(runner.device_id);
  expect(revoked).toHaveLength(4);
  expect(revoked.every((row) => row.enabled === false)).toBe(true);
  expect(
    await ensureDeviceConnectors(
      server.db,
      { tenant_id: server.tenantId, device_id: runner.device_id },
      "de",
    ),
  ).toBe(0);
});

test("a device without a known language gets English connector names", async () => {
  const runner = await enroll("Laptop (Mike)");
  const beat = await call(runner, "POST", "/v1/device-runner/heartbeat", {
    ...heartbeat(0),
    capabilities: ["files"],
  });
  expect(beat.status).toBe(200);
  expect((await deviceConnectors(runner.device_id)).map((row) => row.display_name)).toEqual([
    "Laptop (Mike): Files",
    "Laptop (Mike): Files",
  ]);
});

test("a device without a known language follows the workspace language", async () => {
  await server.db.update(tenants).set({ language: "de" }).where(eq(tenants.id, server.tenantId));
  try {
    const runner = await enroll("Mini (Mike)");
    const beat = await call(runner, "POST", "/v1/device-runner/heartbeat", {
      ...heartbeat(0),
      capabilities: ["files"],
    });
    expect(beat.status).toBe(200);
    expect((await deviceConnectors(runner.device_id)).map((row) => row.display_name)).toEqual([
      "Mini (Mike): Dateien",
      "Mini (Mike): Dateien",
    ]);
  } finally {
    await server.db.update(tenants).set({ language: "en" }).where(eq(tenants.id, server.tenantId));
  }
});
