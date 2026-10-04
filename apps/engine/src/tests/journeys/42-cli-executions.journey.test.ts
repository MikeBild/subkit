import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { defineCommand } from "citty";
import { and, eq } from "drizzle-orm";
import { executionsCommand } from "../../../../sk/src/commands/executions.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let wfId = "";
let executionId = "";
let abortWfId = "";
let abortExecutionId = "";

interface Captured {
  stdout: string;
  stderr: string;
}

function patchStd(): Captured & { restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function isLogLine(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.ts === "string" && typeof o.level === "string" && typeof o.module === "string";
}

function extractLastJson(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      const parsed = JSON.parse(line);
      if (isLogLine(parsed)) continue;
      return line;
    } catch {}
  }
  const text = stdout;
  let depth = 0;
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}" || c === "]") {
      if (end === -1) end = i;
      depth++;
    } else if (c === "{" || c === "[") {
      depth--;
      if (depth === 0 && end !== -1) {
        const candidate = text.slice(i, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (!isLogLine(parsed)) return candidate;
        } catch {}
        end = -1;
      }
    }
  }
  return stdout.trim();
}

function withEnv(url: string, apiKey: string, fn: () => Promise<void>): Promise<void> {
  const prevUrl = process.env.SUBKIT_ENGINE_URL;
  const prevKey = process.env.SUBKIT_API_KEY;
  process.env.SUBKIT_ENGINE_URL = url;
  process.env.SUBKIT_API_KEY = apiKey;
  return fn().finally(() => {
    if (prevUrl === undefined) delete process.env.SUBKIT_ENGINE_URL;
    else process.env.SUBKIT_ENGINE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUBKIT_API_KEY;
    else process.env.SUBKIT_API_KEY = prevKey;
  });
}

function withNoExit(fn: () => Promise<void>): Promise<void> {
  const origExit = process.exit.bind(process);
  (process as { exit: unknown }).exit = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return fn().finally(() => {
    process.exit = origExit;
  });
}

async function run(
  command: ReturnType<typeof defineCommand>,
  cmdPath: string[],
  extraArgs: string[] = [],
): Promise<Captured> {
  const cli = patchStd();
  const argv = [...cmdPath, "--json", ...extraArgs];
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: argv });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

async function runExpectError(
  command: ReturnType<typeof defineCommand>,
  cmdPath: string[],
  extraArgs: string[] = [],
): Promise<{ message: string; captured: Captured }> {
  const cli = patchStd();
  const argv = [...cmdPath, "--json", ...extraArgs];
  let message = "";
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: argv });
      }),
    );
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  } finally {
    cli.restore();
  }
  return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-executions");

  const wf = await seedWorkflow(ctx, {
    slug: "exec-test-wf",
    name: "exec-test-wf",
    steps: [{ kind: "transform", id: "t1", expression: "$input" }],
  });
  wfId = wf.id;

  const runResp = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({ source: "saved", workflow_id: wfId, input: {} }),
  });
  expect(runResp.status).toBe(200);
  const runData = (await runResp.json()) as { execution_id: string };
  executionId = runData.execution_id;

  const abortWf = await seedWorkflow(ctx, {
    slug: "abort-test-wf",
    name: "abort-test-wf",
    steps: [
      {
        kind: "request",
        id: "s1",
        method: "GET",
        url: "http://192.0.2.1/delay/30",
      },
    ],
  });
  abortWfId = abortWf.id;

  const abortRunResp = await journeyFetch(ctx, "/v1/executions", {
    method: "POST",
    body: JSON.stringify({ source: "saved", workflow_id: abortWfId, input: {}, async: true }),
  });
  expect(abortRunResp.status).toBe(202);
  const abortRunData = (await abortRunResp.json()) as { execution_id: string };
  abortExecutionId = abortRunData.execution_id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 42: sk executions CLI", () => {
  test("AC1: executions list returns an array after seeding a run", async () => {
    const { stdout } = await run(executionsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const ids = (body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(executionId);
  });

  test("AC2: executions list --status running returns an array", async () => {
    const { stdout } = await run(executionsCommand, ["list"], ["--status=running"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
  });

  test("AC3: executions get returns the execution with id, workflow_id, status", async () => {
    const { stdout } = await run(executionsCommand, ["get", executionId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(executionId);
    expect(body.workflow_id).toBe(wfId);
    expect(typeof body.status).toBe("string");
    expect(body.status.length).toBeGreaterThan(0);
  });

  test("AC4: executions steps returns an array", async () => {
    const { stdout } = await run(executionsCommand, ["steps", executionId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
  });

  test("AC5: CLI cancellation is durable, audited, and reaches a terminal state", async () => {
    const { stdout: abortStdout } = await run(executionsCommand, ["abort", abortExecutionId]);
    expect(abortStdout).toContain("aborted");

    const persisted = await waitFor(
      async () => {
        const [row] = await ctx.db
          .select()
          .from(executions)
          .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, abortExecutionId)));
        return row && ["aborted", "failed"].includes(row.status) ? row : undefined;
      },
      { tries: 100, sleepMs: 20, label: "cancelled execution terminal" },
    );
    expect(persisted.abort_requested_at).toBeInstanceOf(Date);
    expect(["aborted", "failed"]).toContain(persisted.status);

    const abortAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, abortExecutionId),
          eq(auditLog.action, "execution.abort_requested"),
        ),
      );
    expect(abortAudits).toHaveLength(1);

    const { stdout: getStdout } = await run(executionsCommand, ["get", abortExecutionId]);
    const body = JSON.parse(extractLastJson(getStdout));
    expect(body.id).toBe(abortExecutionId);
    expect(["aborted", "failed"]).toContain(body.status);
  });

  test("AC6: executions get with wrong-tenant id returns an error", async () => {
    const fakeId = "00000000-0000-4000-8000-000000000042";
    const { message, captured } = await runExpectError(executionsCommand, ["get", fakeId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("404") ||
        combined.includes("not found") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });
});
