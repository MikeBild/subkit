import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { defineCommand } from "citty";
import { workflowsCommand } from "../../../../sk/src/commands/workflows.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;

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

async function runPlain(
  command: ReturnType<typeof defineCommand>,
  cmdPath: string[],
  extraArgs: string[] = [],
): Promise<Captured> {
  const cli = patchStd();
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: [...cmdPath, ...extraArgs] });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

const fixture = {
  name: "test-wf",
  slug: "test-wf",
  steps: [{ kind: "transform", id: "step1", language: "javascript", expression: "({ ok: true })" }],
};
const tmpFile = path.join(tmpdir(), `35-cli-wf-${TEST_NOW_MS}.json`);

let createdId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-workflows");
  writeFileSync(tmpFile, JSON.stringify(fixture));
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 35: sk workflows CLI", () => {
  test("AC1: workflows list returns empty array before any workflows exist", async () => {
    const { stdout } = await run(workflowsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test("AC2: workflows create from file produces a workflow with id, name, slug", async () => {
    const { stdout } = await run(workflowsCommand, ["create"], ["--file", tmpFile]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.name).toBe("test-wf");
    expect(body.slug).toBe("test-wf");
    createdId = body.id as string;
  });

  test("AC3: workflows list after create returns at least 1 item containing the new workflow", async () => {
    const { stdout } = await run(workflowsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    const ids = (body as Array<{ id: string }>).map((w) => w.id);
    expect(ids).toContain(createdId);
  });

  test("AC4: workflows get returns the workflow with correct name", async () => {
    const { stdout } = await run(workflowsCommand, ["get", createdId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(createdId);
    expect(body.name).toBe("test-wf");
    expect(body.slug).toBe("test-wf");
  });

  test("AC5: workflows history returns 1 version at version=1 initially", async () => {
    const { stdout } = await run(workflowsCommand, ["history", createdId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    const v1 = (body as Array<{ version: number }>)[0];
    expect(v1?.version).toBe(1);
  });

  test("AC6: after a PUT via HTTP, history returns 2 versions", async () => {
    const patchResp = await journeyFetch(ctx, `/v1/workflows/${createdId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "test-wf-v2",
        slug: "test-wf",
        steps: fixture.steps,
      }),
    });
    expect(patchResp.status).toBe(200);

    const { stdout } = await run(workflowsCommand, ["history", createdId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const versions = (body as Array<{ version: number }>).map((v) => v.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });

  test("AC7: workflows restore <id> 1 creates a new version pointing at v1 dag", async () => {
    const { stdout } = await run(workflowsCommand, ["restore", createdId, "1"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(createdId);
    expect(typeof body.current_version_id).toBe("string");
    expect(body.current_version_id.length).toBeGreaterThan(0);
    expect(typeof body.current_version).toBe("number");
    expect(body.current_version as number).toBeGreaterThanOrEqual(2);
  });

  test("AC8: workflows delete outputs 'deleted'", async () => {
    const { stdout } = await runPlain(workflowsCommand, ["delete", createdId]);
    const nonLogLines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        try {
          const p = JSON.parse(l);
          if (isLogLine(p)) return false;
        } catch {}
        return true;
      });
    expect(nonLogLines).toContain("deleted");
  });

  test("AC9: workflows get after delete returns not_found error", async () => {
    const { message, captured } = await runExpectError(workflowsCommand, ["get", createdId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("404") ||
        combined.includes("not found") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });
});
