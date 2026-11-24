import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type CommandDef, runCommand } from "citty";
import { executionsCommand } from "../commands/executions.ts";
import type { ExecutionDetail, ExecutionStep } from "../engine-client/executions.ts";
import { EngineClient } from "../engine-client.ts";

const EXECUTION_ID = "00000000-0000-4000-8000-000000000597";
const INVOICE_MARKDOWN = "### Dispatch invoice\n\nNet: 43 units";

const executionDetail = (overrides: Partial<ExecutionDetail>): ExecutionDetail =>
  ({
    id: EXECUTION_ID,
    execution_id: EXECUTION_ID,
    workflow_id: "wf-597",
    status: "succeeded",
    hold_writes: false,
    result_markdown: null,
    result_markdown_truncated: false,
    ...overrides,
  }) as ExecutionDetail;

const ledgerStep = {
  step_key: "ledger",
  status: "succeeded",
  output_preview: { checkpoint: "unformatted-ledger" },
  result_preview: null,
  result_storage_uri: null,
} as unknown as ExecutionStep;

const envKeys = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

const runResult = async (execution: ExecutionDetail, rawArgs: string[]) => {
  const executionSpy = spyOn(EngineClient.prototype, "getExecution").mockResolvedValue(execution);
  const stepsSpy = spyOn(EngineClient.prototype, "executionSteps").mockResolvedValue({
    items: [ledgerStep],
  } as Awaited<ReturnType<EngineClient["executionSteps"]>>);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  try {
    const subCommands = executionsCommand.subCommands as Record<string, CommandDef>;
    await runCommand(subCommands.result as CommandDef, { rawArgs: [EXECUTION_ID, ...rawArgs] });
  } finally {
    executionSpy.mockRestore();
    stepsSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
};

describe("sk executions result (#597)", () => {
  beforeEach(() => {
    process.env.SUBKIT_ENGINE_URL = "https://engine.test";
    process.env.SUBKIT_API_KEY = "test-key";
    process.env.SUBKIT_TENANT = "test-tenant";
  });
  afterEach(() => {
    for (const key of envKeys) {
      const savedValue = savedEnv[key];
      if (savedValue === undefined) delete process.env[key];
      else process.env[key] = savedValue;
    }
  });

  test("--json prints the transformed markdown result, not the last step output", async () => {
    const { stdout } = await runResult(executionDetail({ result_markdown: INVOICE_MARKDOWN }), [
      "--json",
    ]);
    expect(JSON.parse(stdout)).toEqual({
      result_markdown: INVOICE_MARKDOWN,
      result_markdown_truncated: false,
    });
    expect(stdout).not.toContain("unformatted-ledger");
  });

  test("text output prints the markdown result and notes truncation", async () => {
    const { stdout, stderr } = await runResult(
      executionDetail({ result_markdown: INVOICE_MARKDOWN, result_markdown_truncated: true }),
      [],
    );
    expect(stdout).toContain(INVOICE_MARKDOWN);
    expect(stdout).not.toContain("unformatted-ledger");
    expect(stderr).toContain("truncated");
  });

  test("falls back to the last step output when the run has no markdown result", async () => {
    const jsonRun = await runResult(executionDetail({}), ["--json"]);
    expect(JSON.parse(jsonRun.stdout)).toEqual({ checkpoint: "unformatted-ledger" });
    const textRun = await runResult(executionDetail({}), []);
    expect(textRun.stdout).toContain("unformatted-ledger");
  });
});
