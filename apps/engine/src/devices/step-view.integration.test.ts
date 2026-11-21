import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, deviceCommands } from "../db/schema/index.ts";
import {
  answer,
  approvedLocalRun,
  dispatchLocalStep,
  enroll,
  type LocalStep,
  pendingCommand,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { screenshotRef } from "./core/step-output.ts";
import { expireScreenshots } from "./screenshot-retention.ts";
import { listExecutionDeviceSteps, readStepScreenshot } from "./step-view.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_step_view");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

const OTHER = "00000000-0000-4000-8000-0000000000bb";
const shop = { origin: "https://shop.example", private: false, site_digest: "e".repeat(64) };
const shot: LocalStep = {
  id: "shot",
  method: "GET",
  path: "/browser.screenshot",
  body: {},
  device: { capability: "browser", sites: [shop] },
};

function person(id: string) {
  return { kind: "user", id, tenant_id: server.tenantId, roles: ["admin"] } as never;
}

async function screenshotRun() {
  const runner = await enroll("Thumb (Mike)");
  const execution_id = await approvedLocalRun(runner, [shot], {
    request_source: "scheduler",
    schedule_created_by: server.userId,
  });
  const running = dispatchLocalStep({ runner, execution_id, step: shot });
  const pending = await pendingCommand(execution_id, "browser.screenshot");
  const png = Buffer.from("redacted-png-bytes");
  await answer(runner, pending.id, {
    status: "done",
    output: { image: { mime: "image/png", base64: png.toString("base64") } },
    evidence: { screenshot_ref: screenshotRef(png) },
  });
  await running;
  return { runner, execution_id, command_id: pending.id, png };
}

describe("the device steps of a run", () => {
  test("the device's person sees target and thumbnail, everyone else only the step", async () => {
    const run = await screenshotRun();
    const own = await listExecutionDeviceSteps(server.db, person(server.userId), run.execution_id);
    expect(own).toEqual([
      {
        command_id: run.command_id,
        step_id: "shot",
        kind: "browser.screenshot",
        state: "done",
        target: "https://shop.example",
        screenshot: true,
      },
    ]);
    const other = await listExecutionDeviceSteps(server.db, person(OTHER), run.execution_id);
    expect(other?.[0]).toMatchObject({ target: null, screenshot: false, state: "done" });

    expect(
      await readStepScreenshot(server.db, person(OTHER), run.execution_id, run.command_id),
    ).toBeNull();
    const png = await readStepScreenshot(
      server.db,
      person(server.userId),
      run.execution_id,
      run.command_id,
    );
    expect(png).toEqual(run.png);
    const audited = await server.db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, server.tenantId),
          eq(auditLog.action, "device.screenshot_viewed"),
          eq(auditLog.resource_id, run.command_id),
        ),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.metadata).toMatchObject({
      device_id: run.runner.device_id,
      capability: "browser",
      execution_id: run.execution_id,
    });
  });

  test("after the 30 days the thumbnail is gone", async () => {
    const run = await screenshotRun();
    await server.db
      .update(deviceCommands)
      .set({ finished_at: sql`clock_timestamp() - interval '31 days'` })
      .where(eq(deviceCommands.id, run.command_id));
    await expireScreenshots(server.db, server.tenantId, new Date()); // allow-wall-clock: retention instant
    const own = await listExecutionDeviceSteps(server.db, person(server.userId), run.execution_id);
    expect(own?.[0]?.screenshot).toBe(false);
    expect(
      await readStepScreenshot(server.db, person(server.userId), run.execution_id, run.command_id),
    ).toBeNull();
  });

  test("a run nobody may see has no device steps", async () => {
    expect(
      await listExecutionDeviceSteps(
        server.db,
        person(server.userId),
        "00000000-0000-4000-8000-0000000000cc",
      ),
    ).toBeNull();
  });

  test("the routes answer the steps and refuse a machine key the thumbnail", async () => {
    const run = await screenshotRun();
    const headers = { authorization: `Bearer ${server.apiKey}` };
    const list = await fetch(`${server.baseUrl}/v1/executions/${run.execution_id}/device-steps`, {
      headers,
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    const image = await fetch(
      `${server.baseUrl}/v1/executions/${run.execution_id}/device-steps/${run.command_id}/screenshot`,
      { headers },
    );
    expect(image.status).toBe(404);
  });
});
