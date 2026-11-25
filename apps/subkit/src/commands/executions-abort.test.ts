import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExecutionDetail } from "../engine-client/executions.ts";
import { EngineClient } from "../engine-client.ts";
import { executionsCommand } from "./executions.ts";

const PROFILE_ENV = {
  SUBKIT_PROFILE: undefined,
  SUBKIT_ENGINE_URL: "https://engine.example.test",
  SUBKIT_API_KEY: "fixture",
  SUBKIT_TENANT: "tenant",
} as const;
const savedEnv = Object.fromEntries(
  Object.keys(PROFILE_ENV).map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;
for (const [key, value] of Object.entries(PROFILE_ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const EXECUTION_ID = "66666666-6666-4666-8666-666666666666";
let currentExecution: Partial<ExecutionDetail> = {};
const getExecution = spyOn(EngineClient.prototype, "getExecution").mockImplementation(
  async () => ({ id: EXECUTION_ID, ...currentExecution }) as ExecutionDetail,
);
const abortExecution = spyOn(EngineClient.prototype, "abortExecution").mockImplementation(
  async () => undefined,
);
const originalExitCode = process.exitCode ?? 0;

afterEach(() => {
  getExecution.mockClear();
  abortExecution.mockClear();
  process.exitCode = originalExitCode;
});
afterAll(() => {
  getExecution.mockRestore();
  abortExecution.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function runAbort(execution: Partial<ExecutionDetail>) {
  currentExecution = execution;
  let stdout = "";
  let stderr = "";
  const writeOut = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const writeErr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const command = (executionsCommand.subCommands as Record<string, unknown>).abort as {
      run: (context: { args: Record<string, unknown> }) => Promise<void>;
    };
    await command.run({ args: { id: EXECUTION_ID } });
    return { stdout, stderr, exitCode: process.exitCode ?? 0 };
  } finally {
    writeOut.mockRestore();
    writeErr.mockRestore();
  }
}

describe("subkit executions abort", () => {
  test("a finished execution is not cancelled and reports its real state", async () => {
    const result = await runAbort({
      status: "succeeded",
      finished_at: "2026-11-20T10:00:00.000Z",
    });
    expect(abortExecution).not.toHaveBeenCalled();
    expect(`${result.stdout}${result.stderr}`).not.toContain("aborted");
    expect(result.stderr).toContain("already succeeded");
    expect(result.stderr).toContain("2026-11-20T10:00:00.000Z");
    expect(result.stderr).toContain("nothing to abort");
    expect(result.exitCode).toBe(1);
  });

  test("an already aborted execution is not cancelled again", async () => {
    const result = await runAbort({ status: "aborted", finished_at: null });
    expect(abortExecution).not.toHaveBeenCalled();
    expect(result.stderr).toContain("already aborted");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  test("a running execution is cancelled and reports the abort request", async () => {
    const result = await runAbort({ status: "running", finished_at: null });
    expect(abortExecution).toHaveBeenCalledTimes(1);
    expect(abortExecution.mock.calls[0]?.[0]).toBe(EXECUTION_ID);
    expect(result.stdout).toContain("aborted");
    expect(result.stdout).toContain(EXECUTION_ID);
    expect(result.exitCode).toBe(0);
  });
});
