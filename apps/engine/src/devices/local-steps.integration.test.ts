import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { deviceCommands, fileLinks } from "../db/schema/index.ts";
import { createExecution } from "../execution/state.ts";
import {
  answer,
  approvedLocalRun,
  call,
  dispatchLocalStep,
  enroll,
  heartbeat,
  type LocalStep,
  pendingCommand,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../http/tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../http/tests/setup.ts";
import { expireScreenshots } from "./screenshot-retention.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_local_steps");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

const D = (c: string) => c.repeat(64);
const docs = { folder_id: "docs", access: "write" as const, root_digest: D("a") };

function writeStep(body: Record<string, unknown> = {}): LocalStep {
  return {
    id: "summary",
    method: "POST",
    path: "/files.write",
    body: { folder_id: "docs", path: "summary.md", content: "# Summary", ...body },
    device: { capability: "files", folders: [docs] },
  };
}

async function commandCount(execution_id: string): Promise<number> {
  const rows = await server.db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.tenant_id, server.tenantId),
        eq(deviceCommands.execution_id, execution_id),
      ),
    );
  return rows.length;
}

describe("a files.write step", () => {
  test("is dispatched with the approved boundary, claimed by the runner and succeeds", async () => {
    const runner = await enroll("Write (Mike)");
    const step = writeStep();
    const execution_id = await approvedLocalRun(runner, [step]);
    const order: string[] = [];
    const effects: ("read" | "write")[] = [];
    const running = dispatchLocalStep({
      runner,
      execution_id,
      step,
      effects,
      before_dispatch: async () => {
        order.push(`before_dispatch:${await commandCount(execution_id)}`);
      },
    });
    const pending = await pendingCommand(execution_id, "files.write");
    const command = await answer(runner, pending.id, {
      status: "done",
      output: {
        size: 9,
        sha256: D("c"),
        replaced: true,
        previous_in_trash: true,
        quarantined: true,
      },
      evidence: { before_version: "v1", after_version: "v2" },
    });
    expect(command.args).toEqual({
      target: { folder_id: "docs", path: "summary.md" },
      content: { encoding: "utf8", text: "# Summary" },
      replace: false,
      boundary: { device_id: runner.device_id, capability: "files", folders: [docs] },
    });
    const result = await running;
    expect(order).toEqual(["before_dispatch:0"]);
    expect(effects).toEqual(["write"]);
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        size: 9,
        sha256: D("c"),
        previous_in_trash: true,
        before_version: "v1",
        after_version: "v2",
      },
    });
  });

  test("a refusal on the device fails the step with the reason and a remedy", async () => {
    const runner = await enroll("Refused (Mike)");
    const step = writeStep({ path: ".env" });
    const execution_id = await approvedLocalRun(runner, [step]);
    const running = dispatchLocalStep({ runner, execution_id, step });
    const pending = await pendingCommand(execution_id, "files.write");
    await answer(runner, pending.id, {
      status: "refused",
      code: "hidden_path",
      detail: "Hidden files and folders are kept out. Nothing was changed.",
    });
    const result = await running;
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "hidden_path",
      message: "Hidden files and folders are kept out. Nothing was changed.",
      guidance: "Use a path without segments that start with a dot.",
    });
  });

  test("a folder filled in at run time outside the approval sends nothing", async () => {
    const runner = await enroll("Outside (Mike)");
    const approved = writeStep();
    const execution_id = await approvedLocalRun(runner, [approved]);
    let before = 0;
    const result = await dispatchLocalStep({
      runner,
      execution_id,
      step: { ...approved, body: { ...(approved.body as object), folder_id: "taxes" } },
      before_dispatch: async () => {
        before += 1;
      },
    });
    expect(result.error?.code).toBe("outside_boundary");
    expect(result.error?.guidance).toContain("approve it again");
    expect(before).toBe(0);
    expect(await commandCount(execution_id)).toBe(0);
  });

  test("an offline device gets the command once it is back and the step then finishes", async () => {
    const runner = await enroll("Offline (Mike)");
    const step = writeStep();
    const execution_id = await approvedLocalRun(runner, [step]);
    const running = dispatchLocalStep({ runner, execution_id, step });
    const pending = await pendingCommand(execution_id, "files.write");
    expect(await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(0))).toMatchObject({
      status: 200,
    });
    await answer(runner, pending.id, {
      status: "done",
      output: { size: 9, sha256: D("d") },
      evidence: { after_version: "v3" },
    });
    expect((await running).status).toBe("succeeded");
  });
});

describe("a held trial run", () => {
  test("holds a local write without an approval and sends nothing", async () => {
    const runner = await enroll("Held (Mike)");
    const execution_id = await createExecution(server.db, {
      tenant_id: server.tenantId,
      workflow_id: null,
      workflow_version_id: null,
      source_kind: "draft",
      source_ref: null,
      request_source: "ui",
    });
    let before = 0;
    const result = await dispatchLocalStep({
      runner,
      execution_id,
      step: writeStep(),
      hold: true,
      before_dispatch: async () => {
        before += 1;
      },
    });
    expect(result.held).toBe(true);
    expect(result.held_request?.body).toEqual({
      kind: "files.write",
      args: {
        target: { folder_id: "docs", path: "summary.md" },
        content: { encoding: "utf8", text: "# Summary" },
        replace: false,
      },
    });
    expect(before).toBe(0);
    expect(await commandCount(execution_id)).toBe(0);
  });
});

describe("a files.import step", () => {
  test("uploads through the runner routes and hands the workflow a linked file", async () => {
    const runner = await enroll("Import step (Mike)");
    const step: LocalStep = {
      id: "fetch",
      method: "POST",
      path: "/files.import",
      body: { folder_id: "docs", path: "in/report.txt", name: "report.txt" },
      device: { capability: "files", folders: [docs] },
    };
    const execution_id = await approvedLocalRun(runner, [step]);
    const running = dispatchLocalStep({ runner, execution_id, step });
    const pending = await pendingCommand(execution_id, "files.import");
    const claimed = await call(
      runner,
      "POST",
      `/v1/device-runner/commands/${pending.id}/claim`,
      {},
    );
    expect(((await claimed.json()) as { args: unknown }).args).toEqual({
      target: { folder_id: "docs", path: "in/report.txt" },
      name: "report.txt",
      boundary: { device_id: runner.device_id, capability: "files", folders: [docs] },
    });
    const bytes = new TextEncoder().encode("quarterly numbers");
    const opened = await call(runner, "POST", "/v1/device-runner/uploads", {
      command_id: pending.id,
      name: "report.txt",
      size: bytes.byteLength,
    });
    const { upload_id } = (await opened.json()) as { upload_id: string };
    await call(runner, "PUT", `/v1/device-runner/uploads/${upload_id}/chunks/0`, undefined, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const committed = await call(runner, "POST", `/v1/device-runner/uploads/${upload_id}/commit`, {
      sha256,
      size: bytes.byteLength,
    });
    const { file_id } = (await committed.json()) as { file_id: string };
    await call(runner, "POST", `/v1/device-runner/commands/${pending.id}/result`, {
      status: "done",
      output: { file_id, name: "report.txt", size: bytes.byteLength, sha256 },
      evidence: {},
    });
    const result = await running;
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        file: { $file: `fid_${file_id}` },
        filename: "report.txt",
        size_bytes: bytes.byteLength,
        file_id,
        sha256,
      },
    });
    const links = await server.db
      .select({ resource_type: fileLinks.resource_type, resource_id: fileLinks.resource_id })
      .from(fileLinks)
      .where(and(eq(fileLinks.tenant_id, server.tenantId), eq(fileLinks.file_id, file_id)));
    expect(links).toContainEqual({ resource_type: "workflow_run", resource_id: execution_id });
  });
});

describe("browser steps", () => {
  const shop = { origin: "https://shop.example", private: false, site_digest: D("e") };

  async function scheduled(runner: Runner, steps: LocalStep[], creator: string | null) {
    return approvedLocalRun(runner, steps, {
      request_source: "scheduler",
      schedule_created_by: creator,
    });
  }

  test("a click takes a fresh snapshot, picks the named element and carries the approved sites", async () => {
    const runner = await enroll("Browser (Mike)");
    const open: LocalStep = {
      id: "open",
      method: "POST",
      path: "/browser.open",
      body: { url: "https://shop.example/orders" },
      device: { capability: "browser", sites: [shop] },
    };
    const click: LocalStep = {
      id: "click",
      method: "POST",
      path: "/browser.press",
      body: { action: "click", element: { role: "button", name: "Download" } },
      device: { capability: "browser" },
    };
    const execution_id = await scheduled(runner, [open, click], server.userId);
    const effects: ("read" | "write")[] = [];
    const running = dispatchLocalStep({ runner, execution_id, step: click, effects });
    const snapshot = await pendingCommand(execution_id, "browser.snapshot");
    const boundary = { device_id: runner.device_id, capability: "browser", sites: [shop] };
    const seen = await answer(runner, snapshot.id, {
      status: "done",
      output: {
        snapshot: {
          snapshot: '- button "Download" [ref=e4]',
          refs: {
            e1: { role: "link", name: "Download" },
            e4: { role: "button", name: "Download" },
          },
        },
      },
      evidence: {},
    });
    expect(seen.args).toEqual({ partition: "c0ffee00-0000-4000-8000-000000000001", boundary });
    const press = await pendingCommand(execution_id, "browser.press");
    const pressed = await answer(runner, press.id, {
      status: "done",
      output: { origin: "https://shop.example" },
      evidence: {},
    });
    expect(pressed.args).toEqual({
      action: "click",
      ref: "e4",
      partition: "c0ffee00-0000-4000-8000-000000000001",
      boundary,
    });
    expect(await running).toMatchObject({
      status: "succeeded",
      output: { origin: "https://shop.example" },
    });
    expect(effects).toEqual(["read", "write"]);
  });

  test("a screenshot stays only as the encrypted device answer, the step keeps its PNG hash", async () => {
    const runner = await enroll("Shot (Mike)");
    const shot: LocalStep = {
      id: "shot",
      method: "GET",
      path: "/browser.screenshot",
      body: {},
      device: { capability: "browser", sites: [shop] },
    };
    const execution_id = await scheduled(runner, [shot], server.userId);
    const running = dispatchLocalStep({ runner, execution_id, step: shot });
    const pending = await pendingCommand(execution_id, "browser.screenshot");
    const png = Buffer.from("redacted-png-bytes");
    const ref = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    await answer(runner, pending.id, {
      status: "done",
      output: { image: { mime: "image/png", base64: png.toString("base64") } },
      evidence: { screenshot_ref: ref },
    });
    const result = await running;
    expect(result).toMatchObject({ status: "succeeded", output: { screenshot_ref: ref } });
    expect(JSON.stringify(result.output)).not.toContain(png.toString("base64"));
    const [row] = await server.db
      .select({ result: deviceCommands.result })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, pending.id));
    expect(JSON.stringify(row?.result)).not.toContain(png.toString("base64"));
    expect(row?.result).toMatchObject({ $sensitive: true });

    expect(await expireScreenshots(server.db, server.tenantId, new Date())).toBe(0); // allow-wall-clock: retention instant
    await server.db
      .update(deviceCommands)
      .set({ finished_at: sql`clock_timestamp() - interval '31 days'` })
      .where(eq(deviceCommands.id, pending.id));
    expect(await expireScreenshots(server.db, server.tenantId, new Date())).toBe(1); // allow-wall-clock: retention instant
    expect(await expireScreenshots(server.db, server.tenantId, new Date())).toBe(0); // allow-wall-clock: retention instant
    const [expired] = await server.db
      .select({ result: deviceCommands.result, state: deviceCommands.state })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, pending.id));
    expect(expired).toEqual({ result: null, state: "done" });
  });

  test("a screenshot whose hash does not match the PNG is not kept in the run", async () => {
    const runner = await enroll("Bad shot (Mike)");
    const shot: LocalStep = {
      id: "shot",
      method: "GET",
      path: "/browser.screenshot",
      body: {},
      device: { capability: "browser", sites: [shop] },
    };
    const execution_id = await scheduled(runner, [shot], server.userId);
    const running = dispatchLocalStep({ runner, execution_id, step: shot });
    const pending = await pendingCommand(execution_id, "browser.screenshot");
    await answer(runner, pending.id, {
      status: "done",
      output: { image: { mime: "image/png", base64: "QUJD" } },
      evidence: { screenshot_ref: `sha256:${D("f")}` },
    });
    expect((await running).error?.code).toBe("screenshot_unverified");
  });

  test("a schedule set up by someone else does not reach the browser", async () => {
    const runner = await enroll("Not mine (Mike)");
    const open: LocalStep = {
      id: "open",
      method: "POST",
      path: "/browser.open",
      body: { url: "https://shop.example/" },
      device: { capability: "browser", sites: [shop] },
    };
    for (const creator of [null, "0b0b0b0b-0000-4000-8000-000000000009"]) {
      const execution_id = await scheduled(runner, [open], creator);
      const result = await dispatchLocalStep({ runner, execution_id, step: open });
      expect(result.error?.code).toBe("schedule_by_someone_else");
      expect(await commandCount(execution_id)).toBe(0);
    }
  });
});
