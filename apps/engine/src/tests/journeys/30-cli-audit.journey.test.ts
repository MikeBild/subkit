// User story: As a compliance engineer, I want to query and export the
// audit log via the `subkit audit` CLI so I can collect SOC 2 evidence
// without writing HTTP calls by hand.
// Acceptance criteria:
//   - AC1: `subkit audit query --action=workflow.created --json` lists
//          the workflow.created row.
//   - AC2: `subkit audit query --json` returns all rows for the tenant.
//   - AC3: `subkit audit query --limit=5 --json` honours the limit.
//   - AC4: `subkit audit show <id>` fetches a single row.
//   - AC5: `subkit audit export` streams ndjson with one row per line.
//   - AC6: Without `--api-key`, the CLI rejects with an auth error.
// Spec refs: docs/07-security-governance.md, docs/03-input-surfaces.md (Pass-2 Stream D)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { auditCommand } from "../../../../sk/src/commands/audit.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

function patchStd() {
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

// Extract the last balanced JSON object or array from a captured stdout
// string. The in-process test harness runs the engine + pg-boss in the
// same process, so async log lines (even though the logger writes to
// stderr in dev mode) can interleave with CLI output via the pg driver
// or hono's internal writes. Filter by walking brackets and returning
// the last complete top-level JSON value.
// Reject objects that look like ndjson log lines — they have
// `{ts, level, module, action, msg}`. The CLI emits audit rows or the
// full list response, which never have `level`.
function isLogLine(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.ts === "string" && typeof o.level === "string" && typeof o.module === "string";
}

function extractLastJson(stdout: string): string {
  // Scan every line that parses as a JSON object or array, return the
  // last one that is NOT a log line.
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
  // Multi-line pretty-printed JSON — walk brackets from the end looking
  // for balanced top-level values, skipping log-line shapes.
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

function withEnv(url: string, apiKey: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prevUrl = process.env.SUBKIT_ENGINE_URL;
  const prevKey = process.env.SUBKIT_API_KEY;
  process.env.SUBKIT_ENGINE_URL = url;
  if (apiKey !== undefined) process.env.SUBKIT_API_KEY = apiKey;
  else delete process.env.SUBKIT_API_KEY;
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
  path: string[],
  extraArgs: Record<string, string> = {},
  opts: { json?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const cli = patchStd();
  const argv = [...path];
  if (opts.json !== false) argv.push("--json");
  for (const [k, v] of Object.entries(extraArgs)) argv.push(`--${k}=${v}`);
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(auditCommand, { rawArgs: argv });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

async function runNoAuth(path: string[]): Promise<{ message: string; stderr: string }> {
  const cli = patchStd();
  const argv = [...path];
  let message = "";
  try {
    await withEnv(ctx.baseUrl, undefined, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(auditCommand, { rawArgs: argv });
      }),
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    cli.restore();
  }
  return { message, stderr: cli.stderr };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-audit");

  // Drive a few auditable operations via REST so rows exist.
  const headers = {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  };
  // 1. workflow.created
  await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "audit-seed",
      slug: "audit-seed",
      steps: [{ kind: "transform", id: "t", expression: "$input" }],
    }),
  });
  // 2. connector.created
  await fetch(`${ctx.baseUrl}/v1/connectors`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "audit-connector",
      slug: "audit-connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    }),
  });
  // 3. api_key.issued (via identity route)
  await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ owner_kind: "system_account", owner_id: ctx.systemAccountId }),
  });
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("journey 30: subkit audit CLI", () => {
  test("AC1: query --action=workflow.created returns the row", async () => {
    const { stdout } = await run(["query"], { action: "workflow.created" });
    const body = JSON.parse(extractLastJson(stdout));
    const items = (body as { items?: unknown[] }).items ?? body;
    expect(Array.isArray(items)).toBe(true);
    expect((items as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((items as Array<{ action: string }>).every((r) => r.action === "workflow.created")).toBe(
      true,
    );
  });

  test("AC2: query returns all rows for the tenant", async () => {
    const { stdout } = await run(["query"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items = body.items ?? body;
    expect(items.length).toBeGreaterThan(1);
    const actions = new Set(items.map((r: { action: string }) => r.action));
    expect(actions.size).toBeGreaterThan(1);
  });

  test("AC3: query honours --limit", async () => {
    const { stdout } = await run(["query"], { limit: "2" });
    const body = JSON.parse(extractLastJson(stdout));
    const items = body.items ?? body;
    expect(items.length).toBeLessThanOrEqual(2);
  });

  test("AC4: show fetches a single row by id", async () => {
    const rows = await ctx.db.select().from(auditLog).limit(1);
    expect(rows.length).toBe(1);
    const id = rows[0]!.id;
    const { stdout } = await run(["show", id]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(id);
  });

  test("AC5: export streams ndjson", async () => {
    const { stdout } = await run(["export"], {}, { json: false });
    // Parse each line and keep only those that look like an audit row.
    const auditRows: Array<{ id: string; action: string; tenant_id: string }> = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        // Only accept shapes that look like audit rows (id + action + tenant_id).
        if (parsed.id && parsed.action && parsed.tenant_id === ctx.tenantId) {
          auditRows.push(parsed);
        }
      } catch {
        // ignore non-JSON lines (log noise)
      }
    }
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    // Count matches a direct DB count for the tenant.
    const countRows = await ctx.db.select({ count: count() }).from(auditLog);
    const dbCount = Number(countRows[0]?.count ?? 0);
    expect(auditRows.length).toBe(dbCount);
  });

  test("AC6: CLI rejects calls without a valid api key", async () => {
    const { message, stderr } = await runNoAuth(["query"]);
    const combined = `${message}\n${stderr}`.toLowerCase();
    expect(
      combined.includes("api_key") ||
        combined.includes("api key") ||
        combined.includes("unauthorized") ||
        combined.includes("401") ||
        combined.includes("credentials"),
    ).toBe(true);
  });
});
