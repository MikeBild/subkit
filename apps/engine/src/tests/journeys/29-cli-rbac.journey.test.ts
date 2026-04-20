// User story: As an operator, I want to manage roles, permissions,
// grants, and groups via the `subkit rbac` CLI so I can automate
// authorization changes without writing curl.
// Acceptance criteria:
//   - AC1: `subkit rbac permissions list --json` returns >= 50 permissions
//          including workflow:run, audit:read, rbac:write.
//   - AC2: `subkit rbac roles list --json` includes the 6 built-in roles.
//   - AC3: `subkit rbac roles create <name>` creates a tenant role.
//   - AC4: `subkit rbac roles grant <role_id> <permission>` attaches a
//          permission to the role.
//   - AC5: `subkit rbac users assign <user_id> <role_id>` changes the
//          user's role_id.
//   - AC6: `subkit rbac grants create` issues a resource grant;
//          `subkit rbac can` subsequently returns allow.
//   - AC7: `subkit rbac groups create` + `add-member` + `assign-role`
//          materialise group rows.
//   - AC8: `subkit rbac roles delete` on the admin built-in returns 409.
// Spec refs: docs/11-identity-and-access.md, docs/26-cli.md
//            (Pass-2 Stream C — fully integrated RBAC)

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
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

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

// Reject objects that look like ndjson log lines — they have
// `{ts, level, module, action, msg}`. The CLI emits rows that never
// have `level`.
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

// ---------- run a subcommand ----------

async function run(path: string[], extraArgs: Record<string, string> = {}): Promise<Captured> {
  const cli = patchStd();
  const argv = [...path];
  argv.push(`--engine-url=${ctx.baseUrl}`);
  argv.push(`--api-key=${ctx.apiKey}`);
  argv.push("--json");
  for (const [k, v] of Object.entries(extraArgs)) {
    argv.push(`--${k}=${v}`);
  }
  try {
    // citty's `runCommand` resolves to void; it dispatches through
    // subCommands by inspecting argv[0]. Reuse it via a dynamic import
    // to avoid dragging citty types into the test surface.
    const citty = await import("citty");
    await citty.runCommand(rbacCommand, { rawArgs: argv });
  } finally {
    cli.restore();
  }
  return { stdout: cli.stdout, stderr: cli.stderr };
}

// `runCommand` throws a citty UsageError on argument parse failures +
// HTTP errors surface as `EngineError` from our engine-client. We swallow
// them here and return the captured stderr so assertions can verify.
async function runExpectError(
  path: string[],
  extraArgs: Record<string, string> = {},
): Promise<{ message: string; captured: Captured }> {
  const cli = patchStd();
  const argv = [...path];
  argv.push(`--engine-url=${ctx.baseUrl}`);
  argv.push(`--api-key=${ctx.apiKey}`);
  for (const [k, v] of Object.entries(extraArgs)) {
    argv.push(`--${k}=${v}`);
  }
  let message = "";
  try {
    const citty = await import("citty");
    await citty.runCommand(rbacCommand, { rawArgs: argv });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    cli.restore();
  }
  return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("cli-rbac");
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

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
    expect(names).toContain("tunnel_agent");
    expect(names).toContain("metrics_scraper");
  });

  test("AC3+AC4: roles create + grant permission", async () => {
    const created = await run(["roles", "create", "ops-engineer"], {
      description: "Ops team day-to-day",
    });
    const role = JSON.parse(extractLastJson(created.stdout));
    expect(role.name).toBe("ops-engineer");
    expect(role.id).toBeTruthy();

    // Grant workflow:run via the CLI.
    await run(["roles", "grant", role.id, "workflow:run"]);

    // Verify the role has the permission via the engine.
    const fetched = await run(["roles", "get", role.id]);
    const parsed = JSON.parse(extractLastJson(fetched.stdout));
    // listRolePermissions returns string[], not objects.
    const perms: string[] = (parsed.permissions ?? []).map((p: unknown) =>
      typeof p === "string" ? p : ((p as { name: string }).name ?? ""),
    );
    expect(perms).toContain("workflow:run");
  });

  test("AC5: users assign role", async () => {
    // Create a fresh user directly in the DB.
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "ops-alice@test.local",
        role: "member",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();

    // Find the ops-engineer role id (created in AC3).
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
    // Create a fresh user who will receive a single resource grant.
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "grant-bob@test.local",
        role: "member",
        role_id: ctx.rbacRoleIds.member,
      })
      .returning();

    // Grant workflow:run on a synthetic workflow id.
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

    // can() query the same combo via CLI.
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

    // Add the seeded admin user as a member.
    await run(["groups", "add-member", group.id, ctx.userId]);
    // Assign the member built-in role to the group.
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

    // Verify the group is listed.
    const listed = await run(["groups", "list"]);
    const groupList = JSON.parse(extractLastJson(listed.stdout));
    expect(groupList.map((g: { name: string }) => g.name)).toContain("oncall");
  });

  test("AC8: deleting a built-in role returns an error", async () => {
    // Look up the admin built-in id.
    const [adminRole] = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, "admin"), eq(roles.is_builtin, true)))
      .limit(1);
    expect(adminRole).toBeTruthy();

    const { message, captured } = await runExpectError(["roles", "delete", adminRole!.id]);
    // Either the CLI throws with a 409/forbidden message or prints it
    // on stderr — accept either path.
    const combined = `${message}\n${captured.stderr}`.toLowerCase();
    expect(
      combined.includes("built-in") ||
        combined.includes("builtin") ||
        combined.includes("409") ||
        combined.includes("conflict") ||
        combined.includes("immutable"),
    ).toBe(true);

    // Built-in is still there.
    const still = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, adminRole!.id))
      .limit(1);
    expect(still.length).toBe(1);
  });
});
