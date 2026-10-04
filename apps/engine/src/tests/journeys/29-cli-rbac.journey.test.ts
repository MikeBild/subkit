import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { rbacCommand } from "../../../../sk/src/commands/rbac.ts";
import {
  groupMembers,
  groupRoleAssignments,
  resourceGrants,
  roles,
  users,
} from "../../db/schema/index.ts";
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

async function run(path: string[], extraArgs: Record<string, string> = {}): Promise<Captured> {
  const cli = patchStd();
  const argv = [...path, "--json"];
  for (const [k, v] of Object.entries(extraArgs)) argv.push(`--${k}=${v}`);
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(rbacCommand, { rawArgs: argv });
      }),
    );
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

async function runExpectError(
  path: string[],
  extraArgs: Record<string, string> = {},
): Promise<{ message: string; captured: Captured }> {
  const cli = patchStd();
  const argv = [...path];
  for (const [k, v] of Object.entries(extraArgs)) argv.push(`--${k}=${v}`);
  let message = "";
  try {
    await withEnv(ctx.baseUrl, ctx.apiKey, () =>
      withNoExit(async () => {
        const citty = await import("citty");
        await citty.runCommand(rbacCommand, { rawArgs: argv });
      }),
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    cli.restore();
  }
  return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-rbac");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 29: subkit rbac CLI", () => {
  test("AC1: rbac permissions list returns the catalog", async () => {
    const { stdout } = await run(["permissions", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(50);
    const names = body.map((p: { name: string }) => p.name);
    expect(names).toContain("workflow:run");
    expect(names).toContain("audit:read");
    expect(names).toContain("rbac:write");
  });

  test("AC2: rbac roles list returns the built-in roles", async () => {
    const { stdout } = await run(["roles", "list"]);
    const body = JSON.parse(extractLastJson(stdout));
    const names = body.map((r: { name: string }) => r.name);
    expect(names).toContain("admin");
    expect(names).toContain("member");
    expect(names).toContain("enduser");
    expect(names).toContain("metrics_scraper");
    expect(names).not.toContain("tunnel_agent");
  });

  test("AC3+AC4: roles create + grant permission", async () => {
    const created = await run(["roles", "create", "ops-engineer"], {
      description: "Ops team day-to-day",
    });
    const role = JSON.parse(extractLastJson(created.stdout));
    expect(role.name).toBe("ops-engineer");
    expect(role.id).toBeTruthy();

    await run(["roles", "grant", role.id, "workflow:run"]);

    const fetched = await run(["roles", "get", role.id]);
    const parsed = JSON.parse(extractLastJson(fetched.stdout));
    const perms: string[] = (parsed.permissions ?? []).map((p: unknown) =>
      typeof p === "string" ? p : ((p as { name: string }).name ?? ""),
    );
    expect(perms).toContain("workflow:run");
  });

  test("AC5: users assign role", async () => {
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "ops-alice@test.local",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();

    const [role] = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenant_id, ctx.tenantId), eq(roles.name, "ops-engineer")))
      .limit(1);
    expect(role).toBeTruthy();

    await run(["users", "assign", u!.id, role!.id]);

    const [after] = await ctx.db.select().from(users).where(eq(users.id, u!.id)).limit(1);
    expect(after?.role_id).toBe(role!.id);
  });

  test("AC6: grants create + can allow", async () => {
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "grant-bob@test.local",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();

    const workflowId = "00000000-0000-0000-0000-0000000000aa";
    await run(["grants", "create"], {
      subject: `user:${u!.id}`,
      resource: `workflow:${workflowId}`,
      permission: "workflow:run",
    });

    const row = await ctx.db
      .select()
      .from(resourceGrants)
      .where(and(eq(resourceGrants.tenant_id, ctx.tenantId), eq(resourceGrants.subject_id, u!.id)))
      .limit(1);
    expect(row.length).toBe(1);

    const can = await run(["can", u!.id, "workflow:run", `workflow:${workflowId}`]);
    const decision = JSON.parse(extractLastJson(can.stdout));
    expect(decision.allow).toBe(true);
  });

  test("AC7: groups create + add-member + assign-role", async () => {
    const created = await run(["groups", "create", "oncall"], {
      description: "on-call rotation",
    });
    const group = JSON.parse(extractLastJson(created.stdout));
    expect(group.name).toBe("oncall");

    await run(["groups", "add-member", group.id, ctx.userId]);
    await run(["groups", "assign-role", group.id, ctx.rbacRoleIds.member]);

    const memberRows = await ctx.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.group_id, group.id));
    expect(memberRows.length).toBe(1);
    const assignRows = await ctx.db
      .select()
      .from(groupRoleAssignments)
      .where(eq(groupRoleAssignments.group_id, group.id));
    expect(assignRows.length).toBe(1);

    const listed = await run(["groups", "list"]);
    const groupList = JSON.parse(extractLastJson(listed.stdout));
    expect(groupList.map((g: { name: string }) => g.name)).toContain("oncall");
  });

  test("AC8: deleting a built-in role returns an error", async () => {
    const [adminRole] = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, "admin"), eq(roles.is_builtin, true)))
      .limit(1);
    expect(adminRole).toBeTruthy();

    const { message, captured } = await runExpectError(["roles", "delete", adminRole!.id, "--yes"]);
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("built-in") ||
        combined.includes("builtin") ||
        combined.includes("409") ||
        combined.includes("conflict") ||
        combined.includes("immutable"),
    ).toBe(true);

    const still = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, adminRole!.id))
      .limit(1);
    expect(still.length).toBe(1);
  });
});
