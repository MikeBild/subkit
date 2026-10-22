import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { logger } from "../logging/logger.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { createCockpitPushFixtures } from "../tests/cockpit-push-fixture.ts";
import { cockpitPushSubject, deliverCockpitPush } from "./cockpit-push.ts";

let ctx: HttpTestServer;
let at: Date;
let fixtures: ReturnType<typeof createCockpitPushFixtures>;
const nextUuid = createDeterministicUuidFactory(0xb0b5);
const spies: Array<{ mockRestore(): void }> = [];

function spy(level: "info" | "warn") {
  const created = spyOn(logger, level);
  spies.push(created);
  return created;
}

function actions(calls: unknown[][]) {
  return calls.map((call) => (call[0] as { action?: string }).action);
}

beforeAll(async () => {
  ctx = await createHttpTestServer("cockpit-push-logs");
  at = new Date(getTestNow());
  fixtures = createCockpitPushFixtures({ db: ctx.db, at, nextUuid });
  await fixtures.prepareKey(ctx.tenantId);
});

afterEach(() => {
  for (const created of spies.splice(0)) created.mockRestore();
});

afterAll(async () => {
  await ctx.cleanup();
});

test("the push subject is only an https origin", () => {
  expect(cockpitPushSubject("https://subkit.example/cockpit/")).toBe("https://subkit.example");
  expect(cockpitPushSubject("http://subkit.example")).toBeNull();
  expect(cockpitPushSubject("")).toBeNull();
  expect(cockpitPushSubject("https://user:secret@subkit.example")).toBeNull();
});

test("a missing subject is logged instead of silently skipped", async () => {
  const warn = spy("warn");
  const fixture = await fixtures.installation(ctx.tenantId);
  const result = await deliverCockpitPush({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    subscription_ids: [fixture.subscriptionId],
    new_items: 1,
    subject: cockpitPushSubject("http://subkit.example"),
    now: at,
  });
  expect(result).toBeNull();
  expect(actions(warn.mock.calls)).toContain("cockpit_push.subject_unavailable");
});

test("send failures carry the status and host without endpoint or key material", async () => {
  const warn = spy("warn");
  const info = spy("info");
  const fixture = await fixtures.installation(ctx.tenantId);
  await deliverCockpitPush({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    subscription_ids: [fixture.subscriptionId],
    new_items: 1,
    subject: "https://subkit.example",
    now: at,
    send: (async () => {
      throw Object.assign(new Error("push service rejected"), { statusCode: 403 });
    }) as never,
  });
  const failure = warn.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((fields) => fields.action === "cockpit_push.send_failed");
  expect(failure).toMatchObject({
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    status_code: 403,
    endpoint_host: "fcm.googleapis.com",
  });
  const serialized = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
  expect(serialized).not.toContain(fixture.endpoint);
  expect(serialized).not.toContain("a".repeat(64));
  expect(serialized).not.toContain("private-key");
  const sent = info.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((fields) => fields.action === "cockpit_push.sent");
  expect(sent).toMatchObject({ attempted: 1, delivered: 0, new_items: 1 });
});

test("a delivery is logged and an empty audience logs nothing at info", async () => {
  const info = spy("info");
  const fixture = await fixtures.installation(ctx.tenantId);
  await deliverCockpitPush({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    subscription_ids: [fixture.subscriptionId],
    new_items: 2,
    subject: "https://subkit.example",
    now: at,
    send: (async () => ({})) as never,
  });
  expect(
    info.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((fields) => fields.action === "cockpit_push.sent"),
  ).toMatchObject({ attempted: 1, delivered: 1, new_items: 2 });
  info.mockClear();
  await deliverCockpitPush({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    installation_id: fixture.installationId,
    subscription_ids: [],
    new_items: 0,
    subject: "https://subkit.example",
    now: at,
    send: (async () => ({})) as never,
  });
  expect(actions(info.mock.calls).filter((action) => action?.startsWith("cockpit_push"))).toEqual(
    [],
  );
});
