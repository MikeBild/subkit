import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { systemAccountsCommand } from "../../../../sk/src/commands/system-accounts.ts";
import { usersCommand } from "../../../../sk/src/commands/users.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

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

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-users-sysaccounts");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 39: sk users CLI", () => {
  test("AC1: users list --json returns >= 1 item; items have id and email", async () => {
    const { stdout } = await run(usersCommand, ["list"]);
    const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; email: string }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.email).toBe("string");
      expect(item.email.length).toBeGreaterThan(0);
    }
  });

  test("AC2: users get <userId> returns the user with matching id and email", async () => {
    const { stdout } = await run(usersCommand, ["get", ctx.userId]);
    const user = JSON.parse(extractLastJson(stdout)) as { id: string; email: string };
    expect(user.id).toBe(ctx.userId);
    expect(typeof user.email).toBe("string");
    expect(user.email.length).toBeGreaterThan(0);
  });

  test("users list returns only the current tenant's users", async () => {
    const { stdout } = await run(usersCommand, ["list"]);
    const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; email: string }>;
    const ids = items.map((u) => u.id);
    expect(ids).toContain(ctx.userId);
    expect(items.length).toBe(1);
  });

  test("users get with non-existent id returns an error", async () => {
    const fakeId = "00000000-0000-4000-8000-000000000077";
    const { message, captured } = await runExpectError(usersCommand, ["get", fakeId]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("not_found") ||
        combined.includes("not found") ||
        combined.includes("404") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });
});

describe("journey 39: sk system-accounts CLI", () => {
  test("AC3: system-accounts list --json returns >= 1 item; items have id and name", async () => {
    const { stdout } = await run(systemAccountsCommand, ["list"]);
    const items = JSON.parse(extractLastJson(stdout)) as Array<{ id: string; name: string }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.name).toBe("string");
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  test("AC4: system-accounts create --name <name> returns an account with id and name", async () => {
    const { stdout } = await run(systemAccountsCommand, ["create", "--name=e2e-bot"]);
    const account = JSON.parse(extractLastJson(stdout)) as { id: string; name: string };
    expect(typeof account.id).toBe("string");
    expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(account.name).toBe("e2e-bot");
  });

  test("AC5: created system account appears in subsequent list", async () => {
    const { stdout: createOut } = await run(systemAccountsCommand, [
      "create",
      "--name=e2e-bot-listed",
    ]);
    const created = JSON.parse(extractLastJson(createOut)) as { id: string; name: string };
    expect(created.id).toBeTruthy();

    const { stdout: listOut } = await run(systemAccountsCommand, ["list"]);
    const items = JSON.parse(extractLastJson(listOut)) as Array<{ id: string }>;
    const ids = items.map((a) => a.id);
    expect(ids).toContain(created.id);
  });

  test("system-accounts list returns only this tenant's accounts", async () => {
    const before = JSON.parse(
      extractLastJson((await run(systemAccountsCommand, ["list"])).stdout),
    ) as unknown[];
    const countBefore = before.length;

    await run(systemAccountsCommand, ["create", "--name=isolation-probe"]);

    const after = JSON.parse(
      extractLastJson((await run(systemAccountsCommand, ["list"])).stdout),
    ) as Array<{ id: string; name: string }>;
    expect(after.length).toBe(countBefore + 1);
    const names = after.map((a) => a.name);
    expect(names).toContain("isolation-probe");
  });

  test("AC6: non-admin key receives an auth error on users list", async () => {
    const cli = patchStd();
    let caughtMessage = "";
    try {
      await withEnv(ctx.baseUrl, "wf_live_bogus_key_that_does_not_exist", () =>
        withNoExit(async () => {
          const citty = await import("citty");
          await citty.runCommand(usersCommand, { rawArgs: ["list", "--json"] });
        }),
      );
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : String(e);
    } finally {
      cli.restore();
    }
    const combined = `${caughtMessage}\n${cli.stderr}`.toLowerCase();
    expect(
      combined.includes("unauthorized") ||
        combined.includes("401") ||
        combined.includes("api_key") ||
        combined.includes("credentials") ||
        combined.includes("process.exit"),
    ).toBe(true);
  });
});
