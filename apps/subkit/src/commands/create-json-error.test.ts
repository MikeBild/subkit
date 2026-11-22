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

class ThrowingEngineClient {
  async validateWorkflowDraft() {
    throw new Error("engine unreachable: validateWorkflowDraft");
  }
  async runExecution() {
    throw new Error("engine unreachable: runExecution");
  }
  async createWorkflow() {
    throw new Error("engine unreachable: createWorkflow");
  }
  async createConnectorFromTemplate() {
    throw new Error("engine unreachable: createConnectorFromTemplate");
  }
  async testConnector() {
    throw new Error("engine unreachable: testConnector");
  }
  async createKnowledgeSource() {
    throw new Error("engine unreachable: createKnowledgeSource");
  }
  async linkFile() {
    return undefined;
  }
}

mock.module("../engine-client.ts", () => ({
  ...ORIGINAL_ENGINE_CLIENT,
  EngineClient: ThrowingEngineClient,
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
  const dir = mkdtempSync(join(tmpdir(), "subkit-create-json-err-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

async function expectThrows(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected handler to throw but command returned normally");
}

describe("subkit workflows create · --json error path", () => {
  test("stderr stays empty; stdout has parseable JSON with 'error' key", async () => {
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
    const err = await expectThrows(create.run!({ args: { file, json: true } }));
    expect(err).toBeInstanceOf(Error);
    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed).toHaveProperty("error");
    expect(typeof parsed.error).toBe("string");
  });
});

describe("subkit connectors create · --json error path", () => {
  test("stderr stays empty; stdout has parseable JSON with 'error' key", async () => {
    const create = getCreate(connectorsCommand);
    const err = await expectThrows(
      create.run!({ args: { template: "stub-template", json: true } }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed).toHaveProperty("error");
    expect(typeof parsed.error).toBe("string");
  });
});

describe("subkit knowledge-sources create · --json error path", () => {
  test("stderr stays empty; stdout has parseable JSON with 'error' key", async () => {
    const file = tmpFile("spec.md", "# stub\n");
    const create = getCreate(knowledgeSourcesCommand);
    const err = await expectThrows(create.run!({ args: { file, json: true } }));
    expect(err).toBeInstanceOf(Error);
    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed).toHaveProperty("error");
    expect(typeof parsed.error).toBe("string");
  });
});
