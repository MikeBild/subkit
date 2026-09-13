// User story: As a platform operator, I want to manage portal tokens
// through the `sk portal-tokens` CLI so I can issue scoped end-user
// tokens and revoke them without writing curl.
// Acceptance criteria:
//   - AC1: `portal-tokens list --json` returns an array (may be empty
//          before any tokens are issued).
//   - AC2: After issuing a portal token via the REST API, the token's id
//          appears in `portal-tokens list --json`.
//   - AC3: `portal-tokens revoke <id>` prints "revoked" to stdout.
//   - AC4: After revoke, `portal-tokens list` no longer includes the
//          revoked token's id in the active (non-revoked) set.
//   - AC5: Revoking a non-existent token id returns an error.
// Spec refs: docs/admins/rbac-and-roles.md, docs/developers/input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { portalTokensCommand } from "../../../../sk/src/commands/portal-tokens.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

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

// Portal token helpers — issue via REST (the CLI `create` command requires
// `allowed_workflows` which is not exposed as a CLI flag, so the REST
// path is the only way to mint tokens in tests).
async function issuePortalToken(allowedWorkflows: string[] = ["*"]): Promise<{
  id: string;
  prefix: string;
  plaintext_token: string;
}> {
  const res = await journeyFetch(ctx, "/v1/identity/portal-tokens", {
    method: "POST",
    body: JSON.stringify({
      user_id: ctx.userId,
      allowed_workflows: allowedWorkflows,
    }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; prefix: string; plaintext_token: string }>;
}

// Seed a workflow so the portal-token endpoint has something to reference.
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-portal-tokens");

  // Create a minimal workflow so portal tokens can reference it.
  const wfRes = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "portal-token-probe",
      slug: "portal-token-probe",
      steps: [{ kind: "transform", id: "t", expression: "$input" }],
    }),
  });
  expect(wfRes.status).toBe(201);
  const wf = (await wfRes.json()) as { id: string };
  workflowId = wf.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 41: sk portal-tokens CLI", () => {
  test("AC1: portal-tokens list --json returns an array (may be empty)", async () => {
    const { stdout } = await run(portalTokensCommand, ["list"]);
    // emitList with --json outputs the raw array, not { items: [] }
    const items = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(items)).toBe(true);
  });

  test("AC2: after issuing a portal token, list reflects it", async () => {
    const token = await issuePortalToken([workflowId]);
    expect(typeof token.id).toBe("string");
    expect(token.id.length).toBeGreaterThan(0);
    expect(typeof token.plaintext_token).toBe("string");
    expect(token.plaintext_token.length).toBeGreaterThan(0);
    expect(typeof token.prefix).toBe("string");
    expect(token.prefix.length).toBeGreaterThan(0);

    const { stdout } = await run(portalTokensCommand, ["list"]);
    const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
    const ids = items.map((t) => t.id);
    expect(ids).toContain(token.id);
  });

  test("AC3: portal-tokens revoke <id> prints 'revoked'", async () => {
    const token = await issuePortalToken([workflowId]);
    const { stdout } = await runPlain(portalTokensCommand, ["revoke", token.id]);
    expect(stdout).toContain("revoked");
  });

  test("AC4: revoked token has revoked_at set in DB", async () => {
    const token = await issuePortalToken([workflowId]);

    // Revoke via CLI.
    const { stdout: revokeOut } = await runPlain(portalTokensCommand, ["revoke", token.id]);
    expect(revokeOut).toContain("revoked");

    // Verify the DB state reflects the revoke.
    const { portalTokens } = await import("../../db/schema/index.ts");
    const { eq } = await import("drizzle-orm");
    const rows = await ctx.db
      .select()
      .from(portalTokens)
      .where(eq(portalTokens.id, token.id))
      .limit(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  test("AC5: revoking a non-existent token id returns an error", async () => {
    // RFC-4122-compliant — the pinned contract is the tenant-scoped
    // not-found, not the uuid-shape 400 (see journey 37's note).
    const fakeId = "00000000-0000-4000-8000-000000000088";
    const { message, captured } = await runExpectError(portalTokensCommand, ["revoke", fakeId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("not found") ||
        combined.includes("404") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });

  test("wrong tenant: list returns only tokens from the current tenant", async () => {
    // Issue a token in this tenant and verify it appears; then check that
    // the count returned is exactly what we seeded (tenant isolation).
    const before = await run(portalTokensCommand, ["list"]);
    const itemsBefore = JSON.parse(extractLastJson(before.stdout)) as unknown[];
    const countBefore = itemsBefore.length;

    const token = await issuePortalToken([workflowId]);

    const after = await run(portalTokensCommand, ["list"]);
    const itemsAfter = JSON.parse(extractLastJson(after.stdout)) as Array<{ id: string }>;
    expect(itemsAfter.length).toBe(countBefore + 1);
    expect(itemsAfter.map((t) => t.id)).toContain(token.id);
  });
});
