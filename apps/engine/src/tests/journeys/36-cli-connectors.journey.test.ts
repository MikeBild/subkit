// User story: As an operator, I want to manage connectors via the
// `sk connectors` CLI so I can automate connector lifecycle without
// writing raw HTTP.
// Acceptance criteria:
//   - AC1: `connectors list --json` returns an array (may be empty initially).
//   - AC2: After creating a connector via the HTTP API, `connectors get <id>`
//          returns the connector with the correct id and name.
//   - AC3: `connectors patch <id> --name "Updated Name"` updates the name.
//   - AC4: `connectors list --json` after create contains at least 1 item.
//   - AC5: `connectors delete <id> --yes` outputs "deleted".
//   - AC6: `connectors get <id>` after delete produces an error / process.exit.
// Spec refs: docs/05-connectors.md, docs/03-input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectorsCommand } from "../../../../sk/src/commands/connectors.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let connectorId = "";
// The engine stores connector names in the `display_name` column; the REST
// response therefore uses `display_name`, not `name`.
const connectorDisplayName = "Journey HTTP Connector";

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
  ctx = await createJourneyCtx("cli-connectors");

  // Create the connector directly via the HTTP API so the journey is
  // not coupled to the `connectors create` command's template look-up.
  const resp = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      slug: "journey-http",
      name: connectorDisplayName,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    }),
  });
  expect(resp.status).toBe(201);
  const body = (await resp.json()) as { id: string; display_name: string };
  connectorId = body.id;
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 30_000);

// ---------- tests ----------

describe("journey 36: sk connectors CLI", () => {
  test("AC1: connectors list --json returns an array initially", async () => {
    const { stdout } = await run(connectorsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
  });

  test("AC2: connectors get <id> returns the correct connector", async () => {
    const { stdout } = await run(connectorsCommand, ["get", connectorId]);
    const body = JSON.parse(extractLastJson(stdout)) as { id: string; display_name: string };
    expect(body.id).toBe(connectorId);
    expect(body.display_name).toBe(connectorDisplayName);
  });

  test("AC3: connectors patch <id> --name updates the display_name", async () => {
    const { stdout } = await run(
      connectorsCommand,
      ["patch", connectorId],
      ["--name", "Updated Name"],
    );
    const body = JSON.parse(extractLastJson(stdout)) as { id: string; display_name: string };
    expect(body.id).toBe(connectorId);
    expect(body.display_name).toBe("Updated Name");
  });

  test("AC4: connectors list --json after create shows at least 1 item", async () => {
    const { stdout } = await run(connectorsCommand, ["list"]);
    const body = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((c) => c.id === connectorId)).toBe(true);
  });

  test("AC5: connectors delete <id> --yes outputs 'deleted'", async () => {
    const { stdout } = await runPlain(connectorsCommand, ["delete", connectorId], ["--yes"]);
    expect(stdout.toLowerCase()).toContain("deleted");
  });

  test("AC6: connectors get <id> after delete produces an error", async () => {
    const { message, captured } = await runExpectError(connectorsCommand, ["get", connectorId]);
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
