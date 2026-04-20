// User story: As an operator, I want to manage tunnels via the
// `sk tunnels` CLI so I can inspect and remove private-network tunnel
// registrations without writing raw HTTP.
// Acceptance criteria:
//   - AC1: `tunnels list --json` returns an array (may be empty initially).
//   - AC2: After pre-registering a tunnel via the HTTP API, `tunnels list --json`
//          contains the created tunnel's id.
//   - AC3: `tunnels get <id>` returns the tunnel with the correct id and name.
//   - AC4: `tunnels delete <id>` outputs "deleted".
//   - AC5: `tunnels get <id>` after delete produces an error / process.exit.
//
// Note: `tunnels create --name <n>` would normally be AC2, but the HTTP
// route for POST /v1/tunnels requires a non-empty `targets` array that the
// CLI command does not expose as arguments. We therefore pre-register the
// tunnel directly via journeyFetch so the remaining CLI verbs can be
// exercised against a real row.
// Spec refs: docs/15-tunnels.md, docs/26-cli.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tunnelsCommand } from "../../../../sk/src/commands/tunnels.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let tunnelId = "";
const tunnelName = "journey-tunnel";

// ---------- stdout / stderr capture ----------

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
      // fall through
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
          // continue
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

// ---------- lifecycle ----------

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-tunnels");

  // Pre-register a tunnel via the HTTP API. The POST /v1/tunnels route
  // requires a non-empty `targets` array that the `sk tunnels create`
  // subcommand does not expose, so we seed the row directly here and then
  // test the remaining CLI verbs (list, get, delete) against it.
  const resp = await journeyFetch(ctx, "/v1/tunnels", {
    method: "POST",
    body: JSON.stringify({
      name: tunnelName,
      targets: [{ name: "local", local_base_url: "http://127.0.0.1:9999" }],
    }),
  });
  expect(resp.status).toBe(201);
  const body = (await resp.json()) as { id: string; name: string };
  tunnelId = body.id;
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

// ---------- tests ----------

describe("journey 38: sk tunnels CLI", () => {
  test("AC1: tunnels list --json initially returns an array", async () => {
    const { stdout } = await run(tunnelsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
  });

  test("AC2: tunnels list --json after pre-register contains the tunnel id", async () => {
    const { stdout } = await run(tunnelsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((t) => t.id === tunnelId)).toBe(true);
  });

  test("AC3: tunnels get <id> returns the correct tunnel", async () => {
    const { stdout } = await run(tunnelsCommand, ["get", tunnelId]);
    const body = JSON.parse(extractLastJson(stdout)) as { id: string; name: string };
    expect(body.id).toBe(tunnelId);
    expect(body.name).toBe(tunnelName);
  });

  test("AC4: tunnels delete <id> outputs 'deleted'", async () => {
    const { stdout } = await runPlain(tunnelsCommand, ["delete", tunnelId]);
    expect(stdout.toLowerCase()).toContain("deleted");
  });

  test("AC5: tunnels get <id> after delete produces an error", async () => {
    const { message, captured } = await runExpectError(tunnelsCommand, ["get", tunnelId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    // The engine returns 404; the CLI surfaces this as a process.exit(1)
    // or an EngineError message. Accept either.
    expect(
      combined.includes("404") ||
        combined.includes("not found") ||
        combined.includes("process.exit") ||
        combined.includes("notfound"),
    ).toBe(true);
  });
});
