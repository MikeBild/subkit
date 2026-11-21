import { expect } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  issueBrowserSession,
  signBrowserCsrf,
  verifyBrowserSession,
} from "../../auth/browser-session.ts";
import {
  deviceCommands,
  workflowExecutionAuthorities,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { openDeviceCommand } from "../../devices/channel.ts";
import { createExecution } from "../../execution/state.ts";
import { DRIVERS } from "../../execution/steps/request/drivers/registry.ts";
import type { StepResult } from "../../execution/types.ts";
import { createOrReuseDesktopInstallation } from "../../identity/index.ts";
import { startListener, stopListener } from "../../pubsub/listener.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export const harness = { server: undefined as unknown as HttpTestServer };
let nonceCounter = 0;
let idCounter = 0;

export function nextId(): number {
  return ++idCounter;
}

export const sent: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
export const boss = {
  send: async (name: string, data: unknown, options: Record<string, unknown> = {}) => {
    sent.push({ name, data, options });
    return (options.id as string | undefined) ?? `job-${sent.length}`;
  },
} as unknown as PgBoss;

export async function setUpDeviceRunner(label: string): Promise<HttpTestServer> {
  harness.server = await createHttpTestServer(label);
  await startListener({ connectionString: harness.server.testDb.url, db: harness.server.db });
  return harness.server;
}

export async function tearDownDeviceRunner(): Promise<void> {
  await stopListener();
  await harness.server?.cleanup();
}

function nonce(): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(++nonceCounter, 12);
  return bytes.toString("base64url");
}

export function uuid(seed: number): string {
  return `e4000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`;
}

export interface Runner {
  device_id: string;
  token: string;
  privateKey: KeyObject;
}

export async function enroll(label: string): Promise<Runner> {
  const { installation } = await createOrReuseDesktopInstallation(
    harness.server.db,
    harness.server.tenantId,
    harness.server.userId,
    { device_id: uuid(++idCounter), device_label: label },
  );
  const issued = await issueBrowserSession({
    db: harness.server.db,
    tenantId: harness.server.tenantId,
    userId: harness.server.userId,
    installationId: installation.id,
    redirectTo: `/cockpit/i/${installation.id}/`,
    via: "desktop_login",
  });
  const cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const payload = await verifyBrowserSession(
    decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)),
  );
  if (!payload) throw new Error("desktop session was not issued");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enrolled = await fetch(
    `${harness.server.baseUrl}/cockpit/i/${installation.id}/api/v1/devices/runner/enroll`,
    {
      method: "POST",
      headers: {
        cookie,
        "x-subkit-csrf": await signBrowserCsrf(payload),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        runner_version: "11.3.0",
      }),
    },
  );
  expect(enrolled.status).toBe(201);
  const { device_runner_id } = (await enrolled.json()) as { device_runner_id: string };
  const assertion = JSON.stringify({
    aud: RUNNER_ASSERTION_AUDIENCE,
    device_runner_id,
    iat: new Date(Date.now()).toISOString(), // allow-wall-clock: the server checks iat against its own clock
    nonce: nonce(),
  });
  const exchanged = await fetch(`${harness.server.baseUrl}/v1/device-runner/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion,
      signature: sign(null, Buffer.from(assertion), privateKey).toString("base64url"),
    }),
  });
  expect(exchanged.status).toBe(200);
  const { access_token } = (await exchanged.json()) as { access_token: string };
  return { device_id: device_runner_id, token: access_token, privateKey };
}

export function call(
  runner: Runner,
  method: string,
  path: string,
  body?: unknown,
  raw?: Uint8Array,
) {
  return fetch(`${harness.server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${runner.token}`,
      "content-type": raw ? "application/octet-stream" : "application/json",
    },
    ...(raw
      ? { body: new Uint8Array(raw).buffer }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
  });
}

export const heartbeat = (generation: number) => ({
  runner_version: "11.3.0",
  os: "darwin",
  capabilities: ["files"],
  personal: [],
  permissions: {},
  allowances_digest: "x",
  generation,
});

export async function command(runner: Runner, kind = "files.list", deadline_ms = 60_000) {
  const command_id = createHash("sha256").update(`command-${++idCounter}`).digest("hex");
  return openDeviceCommand(harness.server.db, {
    command_id,
    tenant_id: harness.server.tenantId,
    device_id: runner.device_id,
    execution_id: null,
    task_run_id: uuid(++idCounter),
    step_id: "list",
    authority_id: null,
    manifest_digest: null,
    kind: kind as "files.list",
    args: { folder_id: "docs" },
    deadline_at: new Date(Date.now() + deadline_ms), // allow-wall-clock: the server checks deadlines on its clock
  });
}

export async function state(command_id: string) {
  const [row] = await harness.server.db
    .select({ state: deviceCommands.state })
    .from(deviceCommands)
    .where(
      and(eq(deviceCommands.tenant_id, harness.server.tenantId), eq(deviceCommands.id, command_id)),
    );
  return row?.state;
}

export interface LocalStep {
  id: string;
  method: string;
  path: string;
  body: unknown;
  device: Omit<DeviceSubBoundary, "device_id">;
}

export async function approvedLocalRun(
  runner: Runner,
  steps: readonly LocalStep[],
  start: { request_source: "ui" | "scheduler"; schedule_created_by?: string | null } = {
    request_source: "ui",
  },
): Promise<string> {
  const n = nextId();
  const [workflow] = await harness.server.db
    .insert(workflows)
    .values({
      tenant_id: harness.server.tenantId,
      slug: `local-steps-${n}`,
      name: `Local steps ${n}`,
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow fixture");
  const [version] = await harness.server.db
    .insert(workflowVersions)
    .values({
      tenant_id: harness.server.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: { name: workflow.name, steps: [] },
    })
    .returning();
  if (!version) throw new Error("version fixture");
  await harness.server.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  if (start.schedule_created_by !== undefined)
    await harness.server.db.insert(workflowsSchedules).values({
      tenant_id: harness.server.tenantId,
      workflow_id: workflow.id,
      cron: "0 7 * * *",
      created_by: start.schedule_created_by,
    });
  const [authority] = await harness.server.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: harness.server.tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: "b".repeat(64),
      effect_manifest: {
        effects: steps.map((step) => ({
          step_id: step.id,
          driver: `local_${step.device.capability}`,
          effect: step.method === "GET" ? "read" : "write",
          device: { device_id: runner.device_id, ...step.device },
        })),
      },
      execution_environment: "prod",
      target_constraints: { targets: [] },
      created_by: harness.server.userId,
    })
    .returning();
  if (!authority) throw new Error("authority fixture");
  return createExecution(harness.server.db, {
    tenant_id: harness.server.tenantId,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    execution_authority_id: authority.id,
    source_kind: "saved",
    source_ref: null,
    request_source: start.request_source,
    execution_mode: "prod",
  });
}

export interface LocalDispatchOptions {
  runner: Runner;
  execution_id: string;
  step: LocalStep;
  connector_id?: string;
  evaluation_seed?: string;
  signal?: AbortSignal;
  before_dispatch?: () => Promise<void>;
  effects?: ("read" | "write")[];
  hold?: boolean;
}

export function dispatchLocalStep(options: LocalDispatchOptions): Promise<StepResult> {
  const driver = `local_${options.step.device.capability}` as
    | "local_files"
    | "local_browser"
    | "local_computer";
  return DRIVERS[driver].execute({
    clock: { now: () => Date.now() }, // allow-wall-clock: the server checks deadlines on its clock
    start: 0,
    signal: options.signal ?? new AbortController().signal,
    connector: {
      id: options.connector_id ?? "c0ffee00-0000-4000-8000-000000000001",
      config: { device_id: options.runner.device_id },
    },
    parts: { path: options.step.path, body: options.step.body },
    state: { holdThisStep: options.hold === true },
    before_dispatch: options.before_dispatch ?? (async () => undefined),
    record_effect: (effect: "read" | "write") => options.effects?.push(effect),
    p: {
      step: {
        id: options.step.id,
        kind: "request",
        method: options.step.method,
        path: options.step.path,
      },
      ctx: {
        db: harness.server.db,
        tenant_id: harness.server.tenantId,
        execution_id: options.execution_id,
        principal: null,
        ...(options.evaluation_seed ? { evaluation_seed: options.evaluation_seed } : {}),
      },
    },
  } as unknown as Parameters<(typeof DRIVERS)["local_files"]["execute"]>[0]);
}

export function pendingCommand(execution_id: string, kind: string) {
  return waitFor(
    async () => {
      const [row] = await harness.server.db
        .select({ id: deviceCommands.id, kind: deviceCommands.kind })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.tenant_id, harness.server.tenantId),
            eq(deviceCommands.execution_id, execution_id),
            eq(deviceCommands.kind, kind as DeviceCommandKind),
            eq(deviceCommands.state, "pending"),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    { sleepMs: 20, label: `pending ${kind}` },
  );
}

export async function answer(runner: Runner, command_id: string, result: unknown) {
  const claimed = await call(runner, "POST", `/v1/device-runner/commands/${command_id}/claim`, {});
  expect(claimed.status).toBe(200);
  const command = (await claimed.json()) as { args: Record<string, unknown> };
  const posted = await call(
    runner,
    "POST",
    `/v1/device-runner/commands/${command_id}/result`,
    result,
  );
  expect(await posted.json()).toMatchObject({ stored: true });
  return command;
}
