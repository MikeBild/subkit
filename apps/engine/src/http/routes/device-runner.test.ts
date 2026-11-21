import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DeviceCommandSchema } from "@shared/device/protocol.ts";
import { and, eq, sql } from "drizzle-orm";
import { deviceCommands, deviceUploads, files } from "../../db/schema/index.ts";
import { workflowCommandId } from "../../devices/core/command-id.ts";
import { sendDeviceCommand } from "../../devices/dispatch.ts";
import { handleDeviceWaitJob } from "../../devices/waiting.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import {
  approvedLocalRun,
  boss,
  call,
  command,
  dispatchLocalStep,
  enroll,
  heartbeat,
  type LocalStep,
  nextId,
  type Runner,
  setUpDeviceRunner,
  state,
  tearDownDeviceRunner,
  uuid,
} from "../tests/device-runner-fixtures.ts";
import type { HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await setUpDeviceRunner("device_runner");
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

describe("claiming and answering commands", () => {
  test("a runner claims a command once and its first result is kept", async () => {
    const runner = await enroll("Claim (Mike)");
    const row = await command(runner);
    const claimed = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    expect(claimed.status).toBe(200);
    const body = DeviceCommandSchema.parse(await claimed.json());
    expect(body.command_id).toBe(row.id);
    expect(body.args).toEqual({ folder_id: "docs" });
    expect(body.generation).toBe(0);
    const again = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    expect(again.status).toBe(409);
    const progress = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/progress`, {
      note: "reading",
    });
    expect(progress.status).toBe(200);
    const done = { status: "done", output: { entries: 2 }, evidence: {} };
    const first = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/result`, done);
    expect(await first.json()).toEqual({ stored: true, state: "done" });
    const repeated = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/result`, {
      status: "failed",
      code: "x",
      detail: "y",
    });
    expect(await repeated.json()).toEqual({ stored: false, state: "done" });
    expect(await state(row.id)).toBe("done");
  });

  test("another device cannot see the command, and an API key is not a runner", async () => {
    const owner = await enroll("Owner (Mike)");
    const other = await enroll("Other (Mike)");
    const row = await command(owner);
    const foreign = await call(other, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    expect(foreign.status).toBe(404);
    const withKey = await fetch(`${server.baseUrl}/v1/device-runner/commands/${row.id}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(withKey.status).toBe(403);
  });

  test("a command past its deadline never starts", async () => {
    const runner = await enroll("Late (Mike)");
    const row = await command(runner, "files.list", -1_000);
    const claimed = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    expect(claimed.status).toBe(409);
    expect(((await claimed.json()) as { code: string }).code).toBe("deadline_passed");
    expect(await state(row.id)).toBe("expired");
  });

  test("a stop closes the commands of the older generation, and later ones carry the new one", async () => {
    const runner = await enroll("Stop (Mike)");
    const pending = await command(runner);
    const stop = await call(runner, "POST", "/v1/device-runner/stop", {
      generation: 1,
      stopped_at: new Date(Date.now()).toISOString(), // allow-wall-clock: stop report instant
    });
    expect(stop.status).toBe(200);
    expect(await state(pending.id)).toBe("stopped");
    const claimed = await call(
      runner,
      "POST",
      `/v1/device-runner/commands/${pending.id}/claim`,
      {},
    );
    expect(claimed.status).toBe(409);
    const next = await command(runner);
    expect(next.generation).toBe(1);
  });

  test("a heartbeat that raises the generation closes older commands too", async () => {
    const runner = await enroll("Beat (Mike)");
    const pending = await command(runner);
    await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(2));
    expect(await state(pending.id)).toBe("stopped");
  });
});

describe("the runner stream", () => {
  test("replays waiting commands, then announces new and cancelled ones", async () => {
    const runner = await enroll("Stream (Mike)");
    const waiting = await command(runner);
    const abort = new AbortController();
    const response = await fetch(`${server.baseUrl}/v1/device-runner/stream`, {
      headers: { authorization: `Bearer ${runner.token}`, accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no stream body");
    let text = "";
    const decoder = new TextDecoder();
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended");
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until(`"command_id":"${waiting.id}"`);
    expect(text).toContain("event: command.available");
    const fresh = await command(runner);
    await until(`"command_id":"${fresh.id}"`);
    await call(runner, "POST", "/v1/device-runner/heartbeat", heartbeat(5));
    await until("event: command.cancelled");
    abort.abort();
  });
});

describe("dispatch from a step", () => {
  test("waits for the runner's result, event-driven", async () => {
    const runner = await enroll("Dispatch (Mike)");
    const command_id = workflowCommandId({
      execution_id: uuid(nextId()),
      step_id: "list",
      call_path: [],
      iteration_path: "seed",
      effect_index: 0,
    });
    const sending = sendDeviceCommand(
      { db: server.db, signal: new AbortController().signal },
      {
        command_id,
        tenant_id: server.tenantId,
        device_id: runner.device_id,
        execution_id: null,
        task_run_id: uuid(nextId()),
        step_id: "list",
        authority_id: null,
        manifest_digest: null,
        kind: "files.list",
        args: {},
        source: null,
      },
    );
    await waitFor(async () => (await state(command_id)) === "pending", { sleepMs: 20 });
    await call(runner, "POST", `/v1/device-runner/commands/${command_id}/claim`, {});
    await call(runner, "POST", `/v1/device-runner/commands/${command_id}/result`, {
      status: "done",
      output: ["a.txt"],
      evidence: {},
    });
    expect(await sending).toEqual({
      kind: "result",
      command_id,
      result: { status: "done", output: ["a.txt"], evidence: {} },
    });
  });

  test("an abort cancels the command and tells the runner", async () => {
    const runner = await enroll("Abort (Mike)");
    const abort = new AbortController();
    const command_id = createHash("sha256").update("abort").digest("hex");
    const sending = sendDeviceCommand(
      { db: server.db, signal: abort.signal },
      {
        command_id,
        tenant_id: server.tenantId,
        device_id: runner.device_id,
        execution_id: null,
        task_run_id: uuid(nextId()),
        step_id: "write",
        authority_id: null,
        manifest_digest: null,
        kind: "files.write",
        args: {},
        source: null,
      },
    );
    await waitFor(async () => (await state(command_id)) === "pending", { sleepMs: 20 });
    abort.abort();
    expect(await sending).toEqual({
      kind: "closed",
      command_id,
      closure: "cancelled",
      effect: "write",
    });
  });

  test("a claimed write with no sign of life is lost and never repeated; a read is reopened once", async () => {
    const runner = await enroll("Lost (Mike)");
    const write = await command(runner, "files.write");
    const read = await command(runner, "files.list");
    for (const row of [write, read])
      await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    const later = () => Date.now() + 60_000; // allow-wall-clock: the server stamps claims on its clock
    const request = (row: typeof write) => ({
      command_id: row.id,
      tenant_id: server.tenantId,
      device_id: runner.device_id,
      execution_id: null,
      task_run_id: row.task_run_id,
      step_id: row.step_id,
      authority_id: null,
      manifest_digest: null,
      kind: row.kind,
      args: {},
      source: null,
    });
    const lost = await sendDeviceCommand(
      { db: server.db, signal: new AbortController().signal, now: later },
      request(write),
    );
    expect(lost).toEqual({
      kind: "closed",
      command_id: write.id,
      closure: "lost",
      effect: "write",
    });
    const reopening = sendDeviceCommand(
      { db: server.db, signal: new AbortController().signal, now: later },
      request(read),
    );
    await waitFor(
      async () => {
        const [row] = await server.db
          .select({ attempt: deviceCommands.attempt, state: deviceCommands.state })
          .from(deviceCommands)
          .where(
            and(eq(deviceCommands.tenant_id, server.tenantId), eq(deviceCommands.id, read.id)),
          );
        return row?.attempt === 2 && row.state === "pending";
      },
      { sleepMs: 20 },
    );
    await call(runner, "POST", `/v1/device-runner/commands/${read.id}/result`, {
      status: "done",
      output: [],
      evidence: {},
    });
    expect((await reopening).kind).toBe("result");
  });

  test("browser and computer steps only run for the device's own person", async () => {
    const runner = await enroll("Source (Mike)");
    const base = {
      command_id: createHash("sha256").update("source").digest("hex"),
      tenant_id: server.tenantId,
      device_id: runner.device_id,
      execution_id: null,
      task_run_id: uuid(nextId()),
      step_id: "open",
      authority_id: null,
      manifest_digest: null,
      kind: "browser.open" as const,
      args: {},
    };
    const signal = new AbortController().signal;
    expect(
      await sendDeviceCommand(
        { db: server.db, signal },
        {
          ...base,
          source: {
            trigger: "webhook",
            started_by: null,
            schedule_created_by: null,
            device_owner: server.userId,
          },
        },
      ),
    ).toEqual({ kind: "refused", command_id: base.command_id, code: "trigger_not_allowed" });
    expect(
      (await sendDeviceCommand({ db: server.db, signal }, { ...base, source: null })).kind,
    ).toBe("refused");
    expect(await state(base.command_id)).toBeUndefined();
  });
});

describe("a write inside a loop", () => {
  test("each iteration sends its own command and a retried job reuses the same ones", async () => {
    const runner = await enroll("Loop (Mike)");
    const docs = { folder_id: "docs", access: "write" as const, root_digest: "a".repeat(64) };
    const step = (item: number): LocalStep => ({
      id: "write",
      method: "POST",
      path: "/files.write",
      body: { folder_id: "docs", path: `item-${item}.txt`, content: String(item) },
      device: { capability: "files", folders: [docs] },
    });
    const execution_id = await approvedLocalRun(runner, [step(0)]);
    const dispatch = (item: number) =>
      dispatchLocalStep({
        runner,
        execution_id,
        step: step(item),
        evaluation_seed: `${execution_id}:for_each:write:${item}`,
      });
    const rows = async () =>
      server.db
        .select({ id: deviceCommands.id, state: deviceCommands.state })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.tenant_id, server.tenantId),
            eq(deviceCommands.execution_id, execution_id),
          ),
        );
    const running = [dispatch(0), dispatch(1)];
    const pending = await waitFor(
      async () => {
        const found = await rows();
        return found.length === 2 && found.every((row) => row.state === "pending") ? found : null;
      },
      { sleepMs: 20 },
    );
    expect(new Set(pending.map((row) => row.id)).size).toBe(2);
    for (const row of pending) {
      await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
      await call(runner, "POST", `/v1/device-runner/commands/${row.id}/result`, {
        status: "done",
        output: { written: row.id },
        evidence: {},
      });
    }
    const results = await Promise.all(running);
    expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
    const retried = await dispatch(0);
    expect(retried.output).toEqual(results[0]?.output);
    expect((await rows()).map((row) => row.id).sort()).toEqual(pending.map((row) => row.id).sort());
  });
});

describe("importing a file from the device", () => {
  async function importCommand(runner: Runner) {
    const row = await command(runner, "files.import");
    await call(runner, "POST", `/v1/device-runner/commands/${row.id}/claim`, {});
    return row;
  }

  test("chunks, a matching hash and the result referencing the stored file", async () => {
    const runner = await enroll("Import (Mike)");
    const row = await importCommand(runner);
    const bytes = new TextEncoder().encode("hello device import");
    const opened = await call(runner, "POST", "/v1/device-runner/uploads", {
      command_id: row.id,
      name: "hello.txt",
      size: bytes.byteLength,
    });
    expect(opened.status).toBe(201);
    const { upload_id } = (await opened.json()) as { upload_id: string };
    expect(
      (
        await call(
          runner,
          "PUT",
          `/v1/device-runner/uploads/${upload_id}/chunks/0`,
          undefined,
          bytes.slice(0, 5),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          runner,
          "PUT",
          `/v1/device-runner/uploads/${upload_id}/chunks/1`,
          undefined,
          bytes.slice(5),
        )
      ).status,
    ).toBe(200);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const committed = await call(runner, "POST", `/v1/device-runner/uploads/${upload_id}/commit`, {
      sha256,
      size: bytes.byteLength,
    });
    expect(committed.status).toBe(200);
    const { file_id } = (await committed.json()) as { file_id: string };
    const [file] = await server.db.select().from(files).where(eq(files.id, file_id));
    expect(file?.sha256).toBe(sha256);
    const result = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/result`, {
      status: "done",
      output: { file_id, name: "hello.txt", size: bytes.byteLength, sha256 },
      evidence: {},
    });
    expect(await result.json()).toEqual({ stored: true, state: "done" });
  });

  test("a mismatched hash is rejected and nothing is kept", async () => {
    const runner = await enroll("Mismatch (Mike)");
    const row = await importCommand(runner);
    const opened = await call(runner, "POST", "/v1/device-runner/uploads", {
      command_id: row.id,
      name: "x.txt",
      size: 3,
    });
    const { upload_id } = (await opened.json()) as { upload_id: string };
    await call(
      runner,
      "PUT",
      `/v1/device-runner/uploads/${upload_id}/chunks/0`,
      undefined,
      new Uint8Array([1, 2, 3]),
    );
    const committed = await call(runner, "POST", `/v1/device-runner/uploads/${upload_id}/commit`, {
      sha256: "0".repeat(64),
      size: 3,
    });
    expect(committed.status).toBe(422);
    expect(((await committed.json()) as { code: string }).code).toBe("hash_mismatch");
    const [upload] = await server.db
      .select()
      .from(deviceUploads)
      .where(eq(deviceUploads.id, upload_id));
    expect(upload?.state).toBe("aborted");
  });

  test("a result naming a file this command did not import is not kept", async () => {
    const runner = await enroll("Forged (Mike)");
    const row = await importCommand(runner);
    const result = await call(runner, "POST", `/v1/device-runner/commands/${row.id}/result`, {
      status: "done",
      output: { file_id: uuid(nextId()) },
      evidence: {},
    });
    expect(await result.json()).toEqual({ stored: true, state: "failed" });
  });

  test("only a running import opens an upload, within the size limit", async () => {
    const runner = await enroll("Limits (Mike)");
    const list = await command(runner, "files.list");
    const notImport = await call(runner, "POST", "/v1/device-runner/uploads", {
      command_id: list.id,
      name: "a",
      size: 1,
    });
    expect(notImport.status).toBe(409);
    const pending = await command(runner, "files.import");
    expect(
      (
        await call(runner, "POST", "/v1/device-runner/uploads", {
          command_id: pending.id,
          name: "a",
          size: 1,
        })
      ).status,
    ).toBe(409);
    const row = await importCommand(runner);
    expect(
      (
        await call(runner, "POST", "/v1/device-runner/uploads", {
          command_id: row.id,
          name: "a",
          size: 90 * 1024 * 1024 + 1,
        })
      ).status,
    ).toBe(400);
  });

  test("an upload that is never committed expires after an hour", async () => {
    const runner = await enroll("Expire (Mike)");
    const row = await importCommand(runner);
    const opened = await call(runner, "POST", "/v1/device-runner/uploads", {
      command_id: row.id,
      name: "late.txt",
      size: 2,
    });
    const { upload_id, expires_at } = (await opened.json()) as {
      upload_id: string;
      expires_at: string;
    };
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(59 * 60_000); // allow-wall-clock: upload lifetime
    await server.db
      .update(deviceUploads)
      .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(deviceUploads.id, upload_id));
    const chunk = await call(
      runner,
      "PUT",
      `/v1/device-runner/uploads/${upload_id}/chunks/0`,
      undefined,
      new Uint8Array([1, 2]),
    );
    expect(chunk.status).toBe(410);
    await handleDeviceWaitJob(server.db, boss, {
      tenant_id: server.tenantId,
      phase: "upload_expire",
    });
    const [upload] = await server.db
      .select()
      .from(deviceUploads)
      .where(eq(deviceUploads.id, upload_id));
    expect(upload?.state).toBe("expired");
  });
});
