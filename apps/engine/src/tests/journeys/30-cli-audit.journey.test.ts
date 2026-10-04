import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { auditCommand } from "../../../../sk/src/commands/audit.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

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

  const headers = {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
  };
  await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "audit-seed",
      slug: "audit-seed",
      steps: [{ kind: "transform", id: "t", expression: "$input" }],
    }),
  });
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
  await fetch(`${ctx.baseUrl}/v1/identity/api-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ owner_kind: "system_account", owner_id: ctx.systemAccountId }),
  });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 30: sk audit CLI", () => {
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
    const auditRows: Array<{ id: string; action: string; tenant_id: string }> = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id && parsed.action && parsed.tenant_id === ctx.tenantId) {
          auditRows.push(parsed);
        }
      } catch {}
    }
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
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
