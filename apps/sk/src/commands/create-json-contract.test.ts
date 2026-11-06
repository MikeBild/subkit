import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realEngineClient = await import("../engine-client.ts");
const realConfig = await import("../config.ts");
const realRenderIndex = await import("../render/index.ts");
const realFiles = await import("./files.ts");

const ORIGINAL_ENGINE_CLIENT = { ...realEngineClient };
const ORIGINAL_CONFIG = { ...realConfig };
const ORIGINAL_RENDER_INDEX = { ...realRenderIndex };
const ORIGINAL_FILES = { ...realFiles };

const renderIntentMock = mock(async (_intent: unknown, _opts?: unknown) => undefined);
const renderSummaryMock = mock(async (_summary: unknown, _opts?: unknown) => undefined);
const renderTaskListMock = mock(async (_phases: unknown, _opts?: unknown) => undefined);

mock.module("../render/index.ts", () => ({
  renderIntent: renderIntentMock,
  renderSummary: renderSummaryMock,
  renderTaskList: renderTaskListMock,
}));

mock.module("../engine-client.ts", () => ({
  ...ORIGINAL_ENGINE_CLIENT,
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

mock.module("../config.ts", () => ({
  ...ORIGINAL_CONFIG,
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-test",
  }),
}));

mock.module("./files.ts", () => ({
  ...ORIGINAL_FILES,
  uploadPath: async () => ({ id: "fid-test" }),
}));

import { connectorsCommand } from "./connectors.ts";
import { knowledgeSourcesCommand } from "./knowledge-sources.ts";

import { workflowsCommand } from "./workflows.ts";

type CittySub = {
  run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown>;
};

function getCreate(parent: unknown): CittySub {
  const sub = (parent as { subCommands?: Record<string, CittySub> }).subCommands;
  if (!sub?.create?.run) {
    throw new Error("expected subCommands.create.run on parent command");
  }
  return sub.create;
}

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

afterAll(() => {
  mock.module("../engine-client.ts", () => ORIGINAL_ENGINE_CLIENT);
  mock.module("../config.ts", () => ORIGINAL_CONFIG);
  mock.module("../render/index.ts", () => ORIGINAL_RENDER_INDEX);
  mock.module("./files.ts", () => ORIGINAL_FILES);
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-create-json-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("sk workflows create · --json contract", () => {
  test("forwards jsonMode:true to renderIntent and renderSummary", async () => {
    const file = tmpFile(
      "wf.json",
      JSON.stringify({
        name: "Stub Workflow",
        slug: "stub-workflow",
        trigger: { kind: "request" },
        steps: [{ key: "s1", kind: "transform" }],
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
        trigger: { kind: "request" },
        steps: [{ key: "s1", kind: "transform" }],
      }),
    );

    const create = getCreate(workflowsCommand);
    await create.run!({ args: { file, json: true } });

    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
  });
});

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
