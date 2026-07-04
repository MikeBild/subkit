// Negative-path `--json` contract: when the engine call throws, each
// create command MUST keep stderr silent and emit a parseable
// `{ "error": <msg> }` object on stdout. The downstream pipe (`sk … |
// jq`) therefore always sees one valid JSON document per invocation,
// success or failure.
//
// We mock the EngineClient with stubs that throw so the outer catch
// fires; the test then asserts the stdout/stderr buffers and that the
// handler re-throws (the top-level `sk` dispatcher is responsible for
// setting `process.exitCode` — handlers MUST NOT call process.exit
// directly, see knowledge-sources-error-discipline.test.ts).

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture real module shapes BEFORE we override them so we can restore
// them in afterAll. `mock.restore()` does NOT undo `mock.module()`
// (see Bun docs); without an explicit re-mock these stubs would leak
// into every other sk test file run in the same worker process.
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

// Each method throws so the outer catch in every create command fires.
// The thrown Error is what the JSON-error path should surface to stdout
// as `{ "error": <message> }`.
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

// uploadPath stays happy — knowledge-sources fails at createKnowledgeSource
// (after upload). This lets the failure mode mirror the runtime path the
// reviewer flagged (engine throw on write).
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

// --- stdout/stderr capture ---
//
// We no longer stub process.exit. The create handlers now re-throw
// the original engine error from their outer catch (after writing the
// JSON envelope to stdout); the test asserts on the rejection itself
// plus the stdout/stderr buffers.

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

// Bun runs multiple test files per worker under --max-concurrency. The
// top-level `mock.module(...)` calls in this file install module mocks
// that would otherwise leak into other files (ThrowingEngineClient
// would poison every test that imports EngineClient). Re-mock with the
// originals captured at the top of the file — `mock.restore()` alone
// does NOT undo `mock.module()`.
afterAll(() => {
  mock.module("../engine-client.ts", () => ORIGINAL_ENGINE_CLIENT);
  mock.module("../config.ts", () => ORIGINAL_CONFIG);
  mock.module("../render/index.ts", () => ORIGINAL_RENDER_INDEX);
  mock.module("./files.ts", () => ORIGINAL_FILES);
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-create-json-err-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// The create handlers re-throw after writing the JSON envelope. We
// catch the rejection here so the assertions on stdout/stderr can
// run without bubbling the engine error up to the test runner.
async function expectThrows(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected handler to throw but command returned normally");
}

describe("sk workflows create · --json error path", () => {
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

describe("sk connectors create · --json error path", () => {
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

describe("sk knowledge-sources create · --json error path", () => {
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
