// Command-layer test for the `--json` contract on the three create
// commands (workflows, connectors, knowledge-sources). Verifies that
// when the user passes `--json`, the command forwards `{ jsonMode: true }`
// to both renderIntent and renderSummary — i.e. narration never leaks
// to stderr alongside the JSON body printed to stdout.
//
// The render-dispatcher-level jsonMode behavior (silent on stderr) is
// covered by render/index.test.ts. This test covers the wiring layer
// the dispatcher tests cannot reach.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the render module with stub functions we can inspect for call shape.
// All three commands import from "../render/index.ts" so this single
// mock.module call wires up all three at once.
const renderIntentMock = mock(async (_intent: unknown, _opts?: unknown) => undefined);
const renderSummaryMock = mock(async (_summary: unknown, _opts?: unknown) => undefined);
const renderTaskListMock = mock(async (_phases: unknown, _opts?: unknown) => undefined);

mock.module("../render/index.ts", () => ({
  renderIntent: renderIntentMock,
  renderSummary: renderSummaryMock,
  renderTaskList: renderTaskListMock,
}));

// Mock the EngineClient so the commands never reach the network. We
// stub only the methods each create flow actually calls; the constructor
// is replaced with a no-op.
mock.module("../engine-client.ts", () => ({
  EngineClient: class StubEngineClient {
    async validateWorkflowDraft() {
      return { ok: true, errors: [] };
    }
    async runExecution() {
      return { status: "succeeded", execution_id: "exec-test", warnings: [] };
    }
    async createWorkflow() {
      return { id: "wf-test", version: 1, name: "Stub Workflow" };
    }
    async createConnectorFromTemplate() {
      return { id: "con-test", slug: "stub-connector" };
    }
    async testConnector() {
      return { ok: true, status_code: 200, duration_ms: 1 };
    }
    async createKnowledgeSource() {
      return { id: "ks-test", name: "Stub KS" };
    }
    async linkFile() {
      return undefined;
    }
  },
}));

// Mock resolveProfile so config does not touch ~/.sk/config.json.
mock.module("../config.ts", () => ({
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-test",
  }),
}));

// uploadPath is used by knowledge-sources create. Stub it to return a fake
// FileWire so the test never goes near a real upload pipeline.
mock.module("./files.ts", () => ({
  uploadPath: async () => ({ id: "fid-test" }),
}));

import { connectorsCommand } from "./connectors.ts";
// Import AFTER the mocks are registered so the commands resolve mocked
// modules at import time.
import { knowledgeSourcesCommand } from "./knowledge-sources.ts";

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

// --- stdout/stderr capture ---

let stderrBuf = "";
let stdoutBuf = "";
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  stderrBuf = "";
  stdoutBuf = "";
  renderIntentMock.mockClear();
  renderSummaryMock.mockClear();
  renderTaskListMock.mockClear();
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
});

// Tempdir helpers — the workflow + knowledge-source create commands
// read real files from disk, so we need to materialise scratch inputs.
function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-create-json-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// ------------------------------------------------------------------
// workflows create --json
// ------------------------------------------------------------------

describe("sk workflows create · --json contract", () => {
  test("forwards jsonMode:true to renderIntent and renderSummary", async () => {
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
    await create.run!({ args: { file, json: true } });

    expect(renderIntentMock).toHaveBeenCalledTimes(1);
    expect(renderSummaryMock).toHaveBeenCalledTimes(1);
    expect(renderIntentMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
    expect(renderSummaryMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
  });

  test("stdout receives JSON body; stderr stays empty", async () => {
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
    await create.run!({ args: { file, json: true } });

    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
  });
});

// ------------------------------------------------------------------
// connectors create --json
// ------------------------------------------------------------------

describe("sk connectors create · --json contract", () => {
  test("forwards jsonMode:true to renderIntent and renderSummary", async () => {
    const create = getCreate(connectorsCommand);
    await create.run!({ args: { template: "stub-template", json: true } });

    expect(renderIntentMock).toHaveBeenCalledTimes(1);
    expect(renderSummaryMock).toHaveBeenCalledTimes(1);
    expect(renderIntentMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
    expect(renderSummaryMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
  });

  test("stdout receives JSON body; stderr stays empty", async () => {
    const create = getCreate(connectorsCommand);
    await create.run!({ args: { template: "stub-template", json: true } });

    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
  });
});

// ------------------------------------------------------------------
// knowledge-sources create --json
// ------------------------------------------------------------------

describe("sk knowledge-sources create · --json contract", () => {
  test("forwards jsonMode:true to renderIntent and renderSummary", async () => {
    const file = tmpFile("spec.md", "# stub spec\nhello world");

    const create = getCreate(knowledgeSourcesCommand);
    await create.run!({ args: { file, json: true } });

    expect(renderIntentMock).toHaveBeenCalledTimes(1);
    expect(renderSummaryMock).toHaveBeenCalledTimes(1);
    expect(renderIntentMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
    expect(renderSummaryMock.mock.calls[0]?.[1]).toEqual({ jsonMode: true });
  });

  test("stdout receives JSON body; stderr stays empty", async () => {
    const file = tmpFile("spec.md", "# stub spec\nhello world");

    const create = getCreate(knowledgeSourcesCommand);
    await create.run!({ args: { file, json: true } });

    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
  });
});
