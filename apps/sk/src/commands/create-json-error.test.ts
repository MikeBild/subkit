// Negative-path `--json` contract: when the engine call throws, each
// create command MUST keep stderr silent and emit a parseable
// `{ "error": <msg> }` object on stdout. The downstream pipe (`sk … |
// jq`) therefore always sees one valid JSON document per invocation,
// success or failure.
//
// We mock the EngineClient with stubs that throw so the outer catch
// fires; the test then asserts the stdout/stderr buffers without
// actually letting the process exit. The exit call is captured by
// stubbing process.exit to a throwing sentinel that the assertion
// recovers from.

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

mock.module("../engine-client.ts", () => ({ EngineClient: ThrowingEngineClient }));

mock.module("../config.ts", () => ({
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-test",
  }),
}));

// uploadPath stays happy — knowledge-sources fails at createKnowledgeSource
// (after upload). This lets the failure mode mirror the runtime path the
// reviewer flagged (engine throw on write).
mock.module("./files.ts", () => ({ uploadPath: async () => ({ id: "fid-test" }) }));

import { connectorsCommand } from "./connectors.ts";
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

// --- stdout/stderr/exit capture ---

let stderrBuf = "";
let stdoutBuf = "";
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origExit = process.exit.bind(process);

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeAll(() => {
  process.exit = ((code?: number) => {
    throw new ExitSentinel(typeof code === "number" ? code : 0);
  }) as typeof process.exit;
});

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

// We do NOT restore process.exit between tests on purpose — every test
// in this file is supposed to drive the create command into its outer
// catch, which exits.

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sk-create-json-err-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

async function expectExit(p: Promise<unknown>): Promise<ExitSentinel> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExitSentinel) return e;
    throw e;
  }
  throw new Error("expected process.exit but command returned normally");
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
    await expectExit(create.run!({ args: { file, json: true } }));
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
    await expectExit(create.run!({ args: { template: "stub-template", json: true } }));
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
    await expectExit(create.run!({ args: { file, json: true } }));
    expect(stderrBuf).toBe("");
    expect(stdoutBuf.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed).toHaveProperty("error");
    expect(typeof parsed.error).toBe("string");
  });
});
