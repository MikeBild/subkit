import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import type { EngineClient } from "../engine-client.ts";
import * as runtime from "./command-runtime.ts";
import { hooksCommand } from "./hooks.ts";
import { saveWorkflow } from "./workflow-save.ts";

let directory: string;
let stderr: string;

const automation = (ready: boolean) => ({
  schedules: [],
  inbound_hooks: [
    {
      inbound_hook_id: "hook-1",
      workflow_id: "wf-1",
      slug: "events",
      state: ready ? "authorized" : "approval_required",
      ready,
      environment: "prod",
      admission_hold: null,
      last_refused_at: null,
      last_refused_reason: null,
    },
  ],
});

function useClient(overrides: Record<string, unknown>) {
  spyOn(runtime, "makeClient").mockReturnValue({
    base: "https://engine.example.test",
    ...overrides,
  } as unknown as EngineClient);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hook-approval-"));
  stderr = "";
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  mock.restore();
  rmSync(directory, { recursive: true, force: true });
});

async function createHook() {
  const secretFile = join(directory, "secret");
  writeFileSync(secretFile, "signing-secret\n");
  await runCommand(hooksCommand, {
    rawArgs: [
      "create",
      "--slug",
      "events",
      "--workflow-id",
      "wf-1",
      "--verifier",
      "github",
      "--secret-file",
      secretFile,
    ],
  });
}

test("hooks create names the approval and links the workflow in Cockpit while it is held", async () => {
  const status = mock(async (_id: string) => automation(false));
  useClient({
    createHookInbound: async () => ({ id: "hook-1", workflow_id: "wf-1", slug: "events" }),
    getWorkflowAutomationStatus: status,
  });
  await createHook();
  expect(status).toHaveBeenCalledWith("wf-1");
  expect(stderr).toContain("do not run until a person approves");
  expect(stderr).toContain("https://engine.example.test/cockpit/workflows/wf-1");
});

test("hooks create stays quiet when the workflow already runs signed deliveries", async () => {
  useClient({
    createHookInbound: async () => ({ id: "hook-1", workflow_id: "wf-1", slug: "events" }),
    getWorkflowAutomationStatus: async () => automation(true),
  });
  await createHook();
  expect(stderr).toBe("");
});

async function createWorkflow(trigger: Record<string, unknown> | undefined) {
  const file = join(directory, "workflow.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "Events",
      ...(trigger ? { trigger } : {}),
      steps: [{ id: "noop", kind: "transform", expression: "$" }],
    }),
  );
  await saveWorkflow({ kind: "create" }, { file, "skip-checks": true });
}

test("workflows create with a webhook trigger names the approval before signed deliveries run", async () => {
  useClient({
    createWorkflow: async () => ({ id: "wf-1", name: "Events" }),
    getWorkflowAutomationStatus: async () => automation(false),
  });
  await createWorkflow({
    kind: "webhook",
    source: "github",
    events: ["push"],
    verify: "github-hmac",
  });
  expect(stderr).toContain("https://engine.example.test/cockpit/workflows/wf-1");
});

test("workflows create without a webhook trigger does not ask for the hook status", async () => {
  const status = mock(async () => automation(false));
  useClient({
    createWorkflow: async () => ({ id: "wf-1", name: "Events" }),
    getWorkflowAutomationStatus: status,
  });
  await createWorkflow(undefined);
  expect(status).not.toHaveBeenCalled();
  expect(stderr).not.toContain("approves runs");
});
