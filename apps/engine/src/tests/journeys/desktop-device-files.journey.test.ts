import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathAllowedPersonal } from "@shared/local-policy/paths.ts";
import { and, eq } from "drizzle-orm";
import { signAssertion } from "../../../../desktop/src/main/runner-key.ts";
import { runRunner } from "../../../../desktop/src/runner/runner.ts";
import { COMPUTER_OFF } from "../../../../desktop/src/shared/local/computer-allowances.ts";
import {
  type FilesSnapshot,
  wireAllowances,
} from "../../../../desktop/src/shared/local/files-allowances.ts";
import type {
  MainToRunner,
  RunnerToMain,
} from "../../../../desktop/src/shared/local/runner-port.ts";
import {
  issueBrowserSession,
  signBrowserCsrf,
  verifyBrowserSession,
} from "../../auth/browser-session.ts";
import { deviceToolSpec } from "../../conversations/core/device-tools/catalog.ts";
import { appendMessage, insertToolCall } from "../../conversations/persistence/index.ts";
import { executeDeviceTool } from "../../conversations/tools/device-tools/run.ts";
import { connectors, deviceCommands, deviceRunners } from "../../db/schema/index.ts";
import { createOrReuseDesktopInstallation } from "../../identity/index.ts";
import { startListener, stopListener } from "../../pubsub/listener.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { makeToolCtx, seedConversation } from "../../test-helpers/seed.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const NOTHING_CHANGED = "Es wurde nichts gesendet oder geändert.";

let ctx: JourneyCtx;
let tree: string;
let docs: string;
let installationId = "";
let cookie = "";
let csrf = "";
let runnerId = "";
let privateKey = "";
let workflowId = "";
let authorityId = "";
let executionId = "";
const states: string[] = [];
const fromRunner: RunnerToMain[] = [];
let toRunner: ((message: MainToRunner) => void) | null = null;

function personalBase(): string {
  const candidates = [join(process.cwd(), ".reports", "journeys"), homedir(), "/Users/Shared"];
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      const real = realpathSync(candidate);
      const probe = join(real, "probe");
      if (pathAllowedPersonal(probe, probe, { os: "darwin", keep_out: [] }).ok) return real;
    } catch {}
  }
  throw new Error("no folder outside system and hidden places to run the device journey in");
}

function snapshot(): FilesSnapshot {
  const stats = statSync(docs);
  return {
    personal_enabled: true,
    home: join(tree, "home"),
    data_dir: join(tree, "data"),
    folders: [
      {
        id: "docs",
        path: docs,
        display: "Docs",
        access: "write",
        volume_id: String(stats.dev),
        file_id: String(stats.ino),
      },
    ],
    keep_out: [{ id: "private", path: join(tree, "home", "Private"), display: "Private" }],
  };
}

function api(path: string): string {
  return `${ctx.baseUrl}/cockpit/i/${installationId}/api${path}`;
}

function asDevice(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("x-subkit-csrf", csrf);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(api(path), { ...init, headers });
}

function answerRunner(message: RunnerToMain): void {
  fromRunner.push(message);
  const send = (reply: MainToRunner) => toRunner?.(reply);
  if (message.type === "ready")
    send({
      type: "start",
      config: {
        server_origin: ctx.baseUrl,
        device_runner_id: runnerId,
        ledger_path: join(tree, "data", "ledger.json"),
        runner_version: "11.3.0",
        locale: "en",
        os: "darwin",
        capabilities: ["files"],
        generation: 0,
        unreported_stop: null,
        files: snapshot(),
        computer: COMPUTER_OFF,
      },
    });
  else if (message.type === "state") states.push(message.state);
  else if (message.type === "sign_assertion")
    send({
      type: "signed",
      request_id: message.request_id,
      signature: signAssertion(privateKey, message.assertion),
    });
  else if (message.type === "volume")
    send({
      type: "volume_id",
      request_id: message.request_id,
      volume_id: String(statSync(message.path).dev),
    });
  else if (message.type === "mark")
    send({ type: "marked", request_id: message.request_id, ok: true });
  else if (message.type === "trash") {
    renameSync(message.path, join(tree, "Trash", basename(message.path)));
    send({ type: "trashed", request_id: message.request_id, ok: true });
  } else if (message.type === "idle_query")
    send({ type: "idle", request_id: message.request_id, seconds: null });
}

function startRunner(): void {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  toRunner = (message) => {
    for (const listener of listeners) listener({ data: message });
  };
  runRunner(
    {
      postMessage: (message) => queueMicrotask(() => answerRunner(message)),
      on: (_event, listener) => listeners.push(listener),
    },
    { exit: () => {} },
  );
}

beforeAll(async () => {
  ctx = await createJourneyCtx("desktop-device-files");
  await startListener({ connectionString: ctx.testDb.url, db: ctx.db });
  tree = realpathSync(mkdtempSync(join(personalBase(), "device-files-")));
  docs = join(tree, "home", "Docs");
  for (const dir of [docs, join(tree, "home", "Private"), join(tree, "data"), join(tree, "Trash")])
    mkdirSync(dir, { recursive: true });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  toRunner?.({ type: "shutdown" });
  await stopListener();
  if (tree) rmSync(tree, { recursive: true, force: true });
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function chatTool(message: string, name: string, input: Record<string, unknown>) {
  const conversation = await seedConversation(ctx.db, {
    tenant_id: ctx.tenantId,
    owner_id: ctx.userId,
  });
  await appendMessage(ctx.db, ctx.tenantId, conversation.id, "user", { text: message });
  const tool_call_id = await insertToolCall(ctx.db, {
    tenant_id: ctx.tenantId,
    conversation_id: conversation.id,
    tool: name,
    input,
    approval_required: false,
  });
  const spec = deviceToolSpec(name);
  if (!spec) throw new Error(name);
  return executeDeviceTool(
    ctx.db,
    spec,
    makeToolCtx({
      db: ctx.db,
      tenant_id: ctx.tenantId,
      conversation_id: conversation.id,
      actor_id: ctx.userId,
      principal: {
        provider: "browser_session",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
        auth_source: { kind: "browser_session", session_id: "desktop-device-files" },
      },
      surface: "web",
      tool_call_id,
      locale: "de",
    }),
    input,
  );
}

describe("a Mac runs files steps for its person", () => {
  test("the desktop enrolls its runner and the heartbeat offers files", async () => {
    const { installation } = await createOrReuseDesktopInstallation(
      ctx.db,
      ctx.tenantId,
      ctx.userId,
      { device_id: "5b2f6a51-8d0e-4c11-9f43-2f3a1c9d7e10", device_label: "Annas MacBook" },
    );
    installationId = installation.id;
    const issued = await issueBrowserSession({
      db: ctx.db,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      installationId,
      redirectTo: `/cockpit/i/${installationId}/`,
      via: "desktop_login",
    });
    cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const payload = await verifyBrowserSession(
      decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)),
    );
    if (!payload) throw new Error("desktop session was not issued");
    csrf = await signBrowserCsrf(payload);
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const enrolled = await asDevice("/v1/devices/runner/enroll", {
      method: "POST",
      body: JSON.stringify({
        public_key: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        runner_version: "11.3.0",
      }),
    });
    expect(enrolled.status).toBe(201);
    runnerId = ((await enrolled.json()) as { device_runner_id: string }).device_runner_id;

    startRunner();
    await waitFor(async () => states.includes("connected"), { sleepMs: 20 });
    await waitFor(
      async () => {
        const [row] = await ctx.db
          .select({ capabilities: deviceRunners.capabilities })
          .from(deviceRunners)
          .where(eq(deviceRunners.id, runnerId));
        return (
          (row?.capabilities as { personal?: string[] } | undefined)?.personal?.[0] === "files"
        );
      },
      { sleepMs: 20 },
    );
    const listed = await asDevice("/v1/devices");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(runnerId);
  });

  test("the allowed folder syncs to the engine as a digest, never as a path", async () => {
    const synced = await asDevice(`/v1/devices/${runnerId}/allowances`, {
      method: "PUT",
      body: JSON.stringify({ allowances: wireAllowances(runnerId, snapshot()) }),
    });
    expect(synced.status).toBe(200);
    const read = await asDevice(`/v1/devices/${runnerId}/allowances`);
    const body = JSON.stringify(await read.json());
    expect(body).toContain("docs");
    expect(body).not.toContain(docs);
  });

  test("a workflow that writes and imports a report is approved for this device", async () => {
    const [connector] = await ctx.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, ctx.tenantId), eq(connectors.driver, "local_files")));
    expect(connector).toBeDefined();
    const created = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        slug: "weekly-report-on-mac",
        name: "Weekly report on the Mac",
        steps: [
          {
            id: "write",
            kind: "request",
            connector_id: connector?.id,
            method: "POST",
            path: "/files.write",
            body: { folder_id: "docs", path: "report.md", content: "# Weekly report" },
          },
          {
            id: "import",
            kind: "request",
            connector_id: connector?.id,
            method: "POST",
            path: "/files.import",
            body: { folder_id: "docs", path: "report.md" },
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as {
      id: string;
      current_version_id: string | null;
      draft_version_id: string | null;
    };
    workflowId = workflow.id;
    const versionId = workflow.draft_version_id ?? workflow.current_version_id;
    const preview = await asDevice(
      `/v1/workflows/${workflowId}/versions/${versionId}/authority-preview?environment=dev`,
    );
    expect(preview.status).toBe(200);
    const shape = (await preview.json()) as {
      digest: string;
      manifest: { effects: Array<{ device?: unknown }> };
      suggested_bounds: { valid_from: string; valid_until: string | null };
    };
    expect(shape.manifest.effects.map((effect) => effect.device)).toContainEqual(
      expect.objectContaining({ device_id: runnerId, capability: "files" }),
    );
    const granted = await asDevice(`/v1/workflows/${workflowId}/execution-authorities`, {
      method: "POST",
      body: JSON.stringify({
        workflow_version_id: versionId,
        execution_environment: "dev",
        expected_manifest_digest: shape.digest,
        valid_from: shape.suggested_bounds.valid_from,
        valid_until: shape.suggested_bounds.valid_until,
        max_runs: 5,
        ...(workflow.draft_version_id
          ? { activation: { expected_current_version_id: workflow.current_version_id } }
          : {}),
      }),
    });
    expect(granted.status).toBe(201);
    authorityId = ((await granted.json()) as { id: string }).id;
  });

  test("the run writes the file atomically, imports it and links it in the step output", async () => {
    const started = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({
        source: "saved",
        workflow_id: workflowId,
        execution_authority_id: authorityId,
        idempotency_key: "device-files-first",
        input: {},
      }),
    });
    expect(started.status).toBeLessThan(300);
    executionId = ((await started.json()) as { execution_id: string }).execution_id;
    await waitFor(
      async () => {
        const run = await journeyFetch(ctx, `/v1/executions/${executionId}`);
        const status = ((await run.json()) as { status: string }).status;
        return status === "succeeded" || status === "failed";
      },
      { sleepMs: 50, tries: 1200 },
    );
    const run = (await (await journeyFetch(ctx, `/v1/executions/${executionId}`)).json()) as {
      status: string;
    };
    expect(run.status).toBe("succeeded");
    expect(readFileSync(join(docs, "report.md"), "utf8")).toBe("# Weekly report");
    expect(readdirSync(docs).filter((name) => name.startsWith(".subkit-"))).toEqual([]);

    const steps = JSON.stringify(
      await (await journeyFetch(ctx, `/v1/executions/${executionId}/steps`)).json(),
    );
    const fileId = /"\$file":"(fid_[0-9a-f-]{36})"/.exec(steps)?.[1];
    expect(fileId).toBeDefined();
    const file = await journeyFetch(ctx, `/v1/files/${fileId}`);
    expect(file.status).toBe(200);
    expect(await file.json()).toMatchObject({ filename: "report.md" });
    const usage = await journeyFetch(ctx, `/v1/files/${fileId}/usage`);
    expect(JSON.stringify(await usage.json())).toContain(executionId);
  });

  test("each device command leaves an audit row with the device", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?limit=500");
    const rows = (
      (await res.json()) as {
        items: Array<{ action: string; details?: { device_id?: string; capability?: string } }>;
      }
    ).items;
    const completed = rows.filter((row) => row.action === "device_command.completed");
    expect(completed.length).toBeGreaterThanOrEqual(2);
    expect(
      completed.every(
        (row) => row.details?.device_id === runnerId && row.details?.capability === "files",
      ),
    ).toBe(true);
    expect(rows.map((row) => row.action)).toContain("device.folder_allowed");
    expect(rows.map((row) => row.action)).toContain("device_runner.enrolled");
  });
});

describe("chat in personal mode", () => {
  test("listing a folder the person named is covered and runs on the Mac", async () => {
    const result = await chatTool(`Zeig mir, was in ${docs} liegt`, "files_list", {
      path: docs,
    });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain("report.md");
  });

  test("writing into a kept-out folder is refused and nothing reaches the Mac", async () => {
    const target = join(tree, "home", "Private", "notes.txt");
    const before = await ctx.db.select({ id: deviceCommands.id }).from(deviceCommands);
    const result = await chatTool(`Speicher eine Notiz als ${target}`, "files_write", {
      path: target,
      text: "geheim",
      because: "Speicher eine Notiz",
    });
    expect(result).toMatchObject({ ok: false, data: { nothing_changed: { de: NOTHING_CHANGED } } });
    expect(existsSync(target)).toBe(false);
    expect(await ctx.db.select({ id: deviceCommands.id }).from(deviceCommands)).toHaveLength(
      before.length,
    );
  });
});

describe("stop on the Mac", () => {
  test("stop ends the generation, is reported and audited, later work runs again", async () => {
    toRunner?.({
      type: "stop",
      report: { generation: 1, stopped_at: new Date(Date.now()).toISOString() }, // allow-wall-clock: the device reports its own stop time
    });
    await waitFor(async () => fromRunner.some((message) => message.type === "stop_reported"), {
      sleepMs: 20,
    });
    expect(states).toContain("stopped");
    const [device] = await ctx.db
      .select({ stop_generation: deviceRunners.stop_generation })
      .from(deviceRunners)
      .where(eq(deviceRunners.id, runnerId));
    expect(device?.stop_generation).toBe(1);
    const res = await journeyFetch(ctx, "/v1/audit-log?limit=500");
    const rows = ((await res.json()) as { items: Array<{ action: string; resource_id?: string }> })
      .items;
    expect(rows).toContainEqual(
      expect.objectContaining({ action: "device.stop", resource_id: runnerId }),
    );
    const later = await chatTool(`Zeig mir, was in ${docs} liegt`, "files_list", { path: docs });
    expect(later).toMatchObject({ ok: true });
  });
});
