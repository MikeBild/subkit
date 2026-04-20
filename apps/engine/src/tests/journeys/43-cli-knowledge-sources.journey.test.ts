// User story: As an operator, I want to manage knowledge sources via the
// `sk knowledge-sources` CLI so I can upload, inspect, update, and remove
// documents without writing HTTP calls by hand.
//
// Acceptance criteria:
//   - AC1: `knowledge-sources list --json` returns an array (may be empty).
//   - AC2: `knowledge-sources create --file <path>` uploads a file and
//          returns a record with id and name.
//   - AC3: The created source appears in a subsequent `list` call.
//   - AC4: `knowledge-sources get <id>` returns the correct record.
//   - AC5: `knowledge-sources patch <id> --title <new>` updates the name.
//   - AC6: `knowledge-sources delete <id>` outputs "deleted".
//   - AC7: `knowledge-sources get <id>` after delete returns an error.
// Spec refs: docs/04-authoring.md, docs/03-input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { knowledgeSourcesCommand } from "../../../../sk/src/commands/knowledge-sources.ts";
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
let tmpFile: string;

// ---------- stdout capture ----------

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
    } catch {
      // fall through to multi-line scan
    }
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
        } catch {
          // continue walking
        }
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
  command: import("citty").CommandDef,
  path: string[],
  extraArgs: string[] = [],
): Promise<Captured> {
  const cli = patchStd();
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

async function runPlain(
  command: import("citty").CommandDef,
  path: string[],
  extraArgs: string[] = [],
): Promise<Captured> {
  const cli = patchStd();
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: [...path, ...extraArgs] });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

async function runExpectError(
  command: import("citty").CommandDef,
  path: string[],
  extraArgs: string[] = [],
): Promise<{ message: string; captured: Captured }> {
  const cli = patchStd();
  let message = "";
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
      }),
    );
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  } finally {
    cli.restore();
  }
  return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
}

// ---------- test state ----------

let createdId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-knowledge-sources");
  tmpFile = path.join(tmpdir(), `ks-test-${Date.now()}.txt`);
  writeFileSync(
    tmpFile,
    "The quick brown fox jumps over the lazy dog. This is a test document for knowledge source ingestion.",
  );
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("journey 43: sk knowledge-sources CLI", () => {
  test("AC1: knowledge-sources list returns an array (may be empty)", async () => {
    const { stdout } = await run(knowledgeSourcesCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    // emitList with --json flag emits the items array directly or wrapped in {items}
    const items = (body as { items?: unknown[] }).items ?? body;
    expect(Array.isArray(items)).toBe(true);
  });

  test("AC2: knowledge-sources create uploads file and returns record with id and name", async () => {
    // The CLI sets `name` to `args.title` if provided, otherwise the basename.
    // The engine returns `name` (not `title`) in the response.
    const { stdout } = await run(
      knowledgeSourcesCommand,
      ["create"],
      ["--file", tmpFile, "--title", "Test Doc"],
    );
    const body = JSON.parse(extractLastJson(stdout));
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    // The create command passes `name = args.title` to the engine; response uses `name`.
    expect(body.name).toBe("Test Doc");
    createdId = body.id as string;
  });

  test("AC3: knowledge-sources list after create contains the new id", async () => {
    const { stdout } = await run(knowledgeSourcesCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items =
      (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
    const ids = (items as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(createdId);
  });

  test("AC4: knowledge-sources get returns the correct record", async () => {
    const { stdout } = await run(knowledgeSourcesCommand, ["get", createdId]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(createdId);
    expect(typeof body.name).toBe("string");
  });

  test("AC5: knowledge-sources patch updates the name", async () => {
    const { stdout } = await run(
      knowledgeSourcesCommand,
      ["patch", createdId],
      ["--title", "Updated Doc"],
    );
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(createdId);
    expect(body.name).toBe("Updated Doc");
  });

  test("AC6: knowledge-sources delete outputs 'deleted'", async () => {
    const { stdout } = await runPlain(knowledgeSourcesCommand, ["delete", createdId]);
    // The delete command emits picocolors green text; the word "deleted" is always present.
    expect(stdout).toContain("deleted");
  });

  test("AC7: knowledge-sources get after delete returns an error", async () => {
    const { message, captured } = await runExpectError(knowledgeSourcesCommand, ["get", createdId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("404") ||
        combined.includes("not found") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });

  // ---- tenant isolation ----

  test("AC8: knowledge source is not accessible without a valid api key", async () => {
    // Attempt a GET with a bogus key — expect 401.
    const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources`, {
      headers: { authorization: "Bearer wf_live_boguskey" },
    });
    expect(res.status).toBe(401);
  });
});
