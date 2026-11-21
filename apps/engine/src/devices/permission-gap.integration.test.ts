import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  call,
  enroll,
  heartbeat,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { buildAttention, invalidateAttention } from "../operator/attention.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_permission_gap");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

function person(id: string, roles: string[]) {
  return { kind: "user", id, tenant_id: server.tenantId, roles } as never;
}

async function reasonsFor(principal: never) {
  invalidateAttention(server.tenantId);
  const attention = await buildAttention(server.db, principal, {
    now: new Date(Date.now()), // allow-wall-clock: attention instant
  });
  return attention.items.filter((item) => item.reason === "device_permission_missing");
}

describe("a Mac whose heartbeat lacks a computer-use permission", () => {
  test("asks its person, not an admin, and clears once the permission is granted", async () => {
    const runner = await enroll("Studio (Mike)");
    const beat = {
      ...heartbeat(0),
      capabilities: ["files", "computer"],
      permissions: { accessibility: true, screen: false },
    };
    expect((await call(runner, "POST", "/v1/device-runner/heartbeat", beat)).status).toBe(200);

    const items = await reasonsFor(person(server.userId, ["member"]));
    expect(items).toHaveLength(1);
    expect(items[0]?.subject).toEqual({
      kind: "device",
      id: runner.device_id,
      name: "Studio (Mike)",
    });
    expect(items[0]?.detail).toBe("Computer use on this Mac lacks: screen");
    expect(items[0]?.actions[0]?.href).toBe("/cockpit/settings?area=devices");

    expect(
      await reasonsFor(person("00000000-0000-4000-8000-0000000000aa", ["admin"])),
    ).toHaveLength(0);

    const granted = { ...beat, permissions: { accessibility: true, screen: true } };
    await call(runner, "POST", "/v1/device-runner/heartbeat", granted);
    expect(await reasonsFor(person(server.userId, ["member"]))).toHaveLength(0);
  });

  test("a Mac without computer use never asks for its permissions", async () => {
    const runner = await enroll("Files only (Mike)");
    await call(runner, "POST", "/v1/device-runner/heartbeat", {
      ...heartbeat(0),
      permissions: { accessibility: false, screen: false },
    });
    const items = await reasonsFor(person(server.userId, ["member"]));
    expect(items.some((item) => item.subject?.id === runner.device_id)).toBe(false);
  });
});
