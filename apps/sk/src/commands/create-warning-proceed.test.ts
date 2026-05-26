// Positive-path coverage for the "preview warnings → commit proceeds"
// flow. The earlier predicate conflated `warnings.length > 0` with
// "preview failed"; the fix in `workflows.ts` decouples them — warnings
// surface in the task list with `status: "warning"`, the create still
// commits, and the summary card still renders.
//
// This test pins that contract: when runExecution returns succeeded +
// warnings, we expect createWorkflow to be called (the commit) AND
// renderTaskList to be called with a phase whose status is "warning"
// and whose detail names the warning code.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const renderIntentMock = mock(async (_intent: unknown, _opts?: unknown) => undefined);
const renderSummaryMock = mock(async (_summary: unknown, _opts?: unknown) => undefined);
const renderTaskListMock = mock(async (_phases: unknown, _opts?: unknown) => undefined);

mock.module("../render/index.ts", () => ({
  renderIntent: renderIntentMock,
  renderSummary: renderSummaryMock,
  renderTaskList: renderTaskListMock,
}));

const createWorkflowSpy = mock(async () => ({
  id: "wf-1",
  version: 1,
  name: "Stub Workflow",
  definition: {},
}));

mock.module("../engine-client.ts", () => ({
  EngineClient: class StubEngineClient {
    async validateWorkflowDraft() {
      return { ok: true, errors: [] };
    }
    async runExecution() {
      return {
        status: "succeeded",
        execution_id: "ex-1",
        warnings: [{ step_key: "s1", code: "unresolved_identifier", message: "x is not defined" }],
      };
    }
    createWorkflow = createWorkflowSpy;
  },
}));

mock.module("../config.ts", () => ({
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-test",
  }),
}));

import { workflowsCommand } from "./workflows.ts";

type CittySub = {
  run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown>;
};

function getCreate(parent: unknown): CittySub {
  const sub = (parent as { subCommands?: Record<string, CittySub> }).subCommands;
  if (!sub || !sub.create || !sub.create.run) {
    throw new Error("expected subCommands.create.run on parent command");
  }
  return sub.create;
}

// Silence stdout (createWorkflow result + printJson) so the test
// output isn't polluted. The test does not assert on stdout content;
// it asserts that the render mocks and the createWorkflow spy were
// called with the right shapes.
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  renderIntentMock.mockClear();
  renderSummaryMock.mockClear();
  renderTaskListMock.mockClear();
  createWorkflowSpy.mockClear();
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-warn-proceed-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("sk workflows create · preview warnings → commit proceeds", () => {
  test("warnings render but createWorkflow is still called and summary renders", async () => {
    const file = tmpFile(
      "wf.json",
      JSON.stringify({
        name: "Stub Workflow",
        slug: "stub-workflow",
        definition: {
          trigger: { kind: "request" },
          steps: [{ key: "s1", kind: "transform" }],
        },
      }),
    );

    const create = getCreate(workflowsCommand);
    // No --json → narration on; the test asserts that warnings do NOT
    // short-circuit the create. We do NOT assert exit code (it should
    // be 0 / no process.exit call) — instead we verify the commit
    // path executed end-to-end.
    await create.run!({ args: { file, json: false } });

    // Commit happened.
    expect(createWorkflowSpy).toHaveBeenCalledTimes(1);
    // Success card rendered.
    expect(renderSummaryMock).toHaveBeenCalledTimes(1);
    // Task list received a "warning" phase with the warning code in detail.
    expect(renderTaskListMock).toHaveBeenCalled();
    const warningCall = renderTaskListMock.mock.calls.find((call) => {
      const phases = call[0] as Array<{ status: string; detail?: string }> | undefined;
      return phases?.some(
        (p) => p.status === "warning" && (p.detail ?? "").includes("unresolved_identifier"),
      );
    });
    expect(warningCall).toBeDefined();
  });
});
