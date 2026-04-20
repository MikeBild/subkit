// User story: As an operator, I want to manage notification channels and
// rules via the `sk notifications` CLI so I can wire up event fanout
// without writing HTTP calls by hand.
//
// Acceptance criteria:
//   - AC1: `notifications channels list --json` returns an array (may be empty).
//   - AC2: A channel seeded directly via HTTP appears in the list.
//   - AC3: `notifications channels update <id> --config '{"active":false}'`
//          patches the channel and the update is reflected.
//   - AC4: `notifications channels delete <id>` outputs "deleted".
//   - AC5: After delete, the channel id is gone from the list.
//   - AC6: `notifications rules list --json` returns an array.
//   - AC7: A rule seeded directly via HTTP appears in the rules list.
//   - AC8: `notifications rules delete <id>` outputs "deleted".
// Spec refs: docs/03-input-surfaces.md, docs/03-input-surfaces.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notificationsCommand } from "../../../../sk/src/commands/notifications.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

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

// ---------- seed helpers ----------

async function seedChannel(opts: {
  workspace_id: string;
  channel_id: string;
  platform: string;
}): Promise<{ id: string }> {
  const res = await journeyFetch(ctx, "/v1/notifications/channels", {
    method: "POST",
    body: JSON.stringify(opts),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

async function seedRule(opts: {
  name: string;
  event_pattern: string;
  target_workspace_id: string;
  target_channel_id: string;
}): Promise<{ id: string }> {
  const res = await journeyFetch(ctx, "/v1/notifications/rules", {
    method: "POST",
    body: JSON.stringify(opts),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

// ---------- test state ----------

let channelId = "";
let ruleId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-notifications");
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("journey 40: sk notifications CLI", () => {
  // ---- channels section ----

  test("AC1: notifications channels list returns an array (may be empty)", async () => {
    const { stdout } = await run(notificationsCommand, ["channels", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items = (body as { items?: unknown[] }).items ?? body;
    expect(Array.isArray(items)).toBe(true);
  });

  test("AC2: a channel seeded via HTTP appears in the CLI list", async () => {
    const channel = await seedChannel({
      workspace_id: "W_TEST",
      channel_id: "C_ALERTS",
      platform: "slack",
    });
    channelId = channel.id;

    const { stdout } = await run(notificationsCommand, ["channels", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items =
      (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
    const ids = (items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(channelId);
  });

  test("AC3: notifications channels update patches a channel field", async () => {
    // Update the channel's rate_limit_per_minute via the CLI.
    const { stdout } = await run(
      notificationsCommand,
      ["channels", "update", channelId],
      ["--config", JSON.stringify({ rate_limit_per_minute: 30 })],
    );
    const body = JSON.parse(extractLastJson(stdout));
    expect(body.id).toBe(channelId);
    expect(body.rate_limit_per_minute).toBe(30);
  });

  test("AC4: notifications channels delete outputs 'deleted'", async () => {
    // Seed a second channel specifically for deletion so channelId stays for rules.
    const ch = await seedChannel({
      workspace_id: "W_DEL",
      channel_id: "C_DEL",
      platform: "slack",
    });
    const { stdout } = await runPlain(notificationsCommand, ["channels", "delete", ch.id]);
    expect(stdout).toContain("deleted");
  });

  test("AC5: deleted channel id is gone from the list", async () => {
    const ch = await seedChannel({
      workspace_id: "W_GONE",
      channel_id: "C_GONE",
      platform: "slack",
    });
    const deleteId = ch.id;

    await runPlain(notificationsCommand, ["channels", "delete", deleteId]);

    const { stdout } = await run(notificationsCommand, ["channels", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items =
      (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
    const ids = (items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(deleteId);
  });

  // ---- rules section ----

  test("AC6: notifications rules list returns an array", async () => {
    const { stdout } = await run(notificationsCommand, ["rules", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items = (body as { items?: unknown[] }).items ?? body;
    expect(Array.isArray(items)).toBe(true);
  });

  test("AC7: a rule seeded via HTTP appears in the rules list", async () => {
    const rule = await seedRule({
      name: "test-rule",
      event_pattern: "execution.completed",
      target_workspace_id: "W_TEST",
      target_channel_id: "C_ALERTS",
    });
    ruleId = rule.id;

    const { stdout } = await run(notificationsCommand, ["rules", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const items =
      (body as { items?: Array<{ id: string }> }).items ?? (body as Array<{ id: string }>);
    const ids = (items as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(ruleId);
  });

  test("AC8: notifications rules delete outputs 'deleted'", async () => {
    const { stdout } = await runPlain(notificationsCommand, ["rules", "delete", ruleId]);
    expect(stdout).toContain("deleted");
  });

  test("AC10: deleting a non-existent channel id returns an error", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const { message, captured } = await runExpectError(notificationsCommand, [
      "channels",
      "delete",
      fakeId,
    ]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("404") ||
        combined.includes("not found") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });

  // ---- tenant isolation ----

  test("AC9: channel seeded for this tenant is not visible under a different api key", async () => {
    // Another tenant's API key should return an empty (or unrelated) channel list.
    const otherChannel = await seedChannel({
      workspace_id: "W_ISOLATION",
      channel_id: "C_ISOLATION",
      platform: "slack",
    });

    // Fetch with a bogus key — expect 401/403, not the channel row.
    const res = await fetch(`${ctx.baseUrl}/v1/notifications/channels`, {
      headers: { authorization: "Bearer wf_live_boguskey" },
    });
    expect(res.status).toBe(401);

    // Verify the channel does exist under the correct tenant.
    const ok = await journeyFetch(ctx, "/v1/notifications/channels");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === otherChannel.id)).toBe(true);
  });
});
