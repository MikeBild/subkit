import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditCommand } from "../../../../sk/src/commands/audit.ts";
import { rbacCommand } from "../../../../sk/src/commands/rbac.ts";
import {
  auditLog,
  groupMembers,
  groupRoleAssignments,
  resourceGrants,
  roles,
  users,
} from "../../db/schema/index.ts";
import { type Captured, extractLastJson, patchStd, withEnv, withNoExit } from "./cli-capture.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

describe("an admin governs access and reads the audit trail from the sk CLI", () => {
  describe("sk rbac", () => {
    let ctx: JourneyCtx;

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
        .where(
          and(eq(resourceGrants.tenant_id, ctx.tenantId), eq(resourceGrants.subject_id, u!.id)),
        )
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

      const { message, captured } = await runExpectError([
        "roles",
        "delete",
        adminRole!.id,
        "--yes",
      ]);
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

  describe("sk audit", () => {
    let ctx: JourneyCtx;

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
      const workflowResponse = await fetch(`${ctx.baseUrl}/v1/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "audit-seed",
          slug: "audit-seed",
          steps: [
            { kind: "transform", id: "t", language: "javascript", expression: "return input;" },
          ],
        }),
      });
      expect(workflowResponse.status).toBe(201);
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

    test("AC1: query --action=workflow.created returns the row", async () => {
      const { stdout } = await run(["query"], { action: "workflow.created" });
      const body = JSON.parse(extractLastJson(stdout));
      const items = (body as { items?: unknown[] }).items ?? body;
      expect(Array.isArray(items)).toBe(true);
      expect((items as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect(
        (items as Array<{ action: string }>).every((r) => r.action === "workflow.created"),
      ).toBe(true);
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

  describe("the sk role matrix", () => {
    let ctx: JourneyCtx;

    interface CanResult {
      allow: boolean;
      reason: string | null;
      source: string | null;
    }

    const NEW_PERMISSIONS = [
      "conversation:read",
      "conversation:write",
      "conversation:approve",
      "conversation:cancel",
      "conversation:commit",
      "conversation:list",
      "memory:write",
      "mcp:read",
    ] as const;

    type NewPermission = (typeof NEW_PERMISSIONS)[number];

    const EXPECTED: Record<string, Record<NewPermission, boolean>> = {
      admin: {
        "conversation:read": true,
        "conversation:write": true,
        "conversation:approve": true,
        "conversation:cancel": true,
        "conversation:commit": true,
        "conversation:list": true,
        "memory:write": true,
        "mcp:read": true,
      },
      member: {
        "conversation:read": true,
        "conversation:write": true,
        "conversation:approve": true,
        "conversation:cancel": true,
        "conversation:commit": true,
        "conversation:list": true,
        "memory:write": true,
        "mcp:read": true,
      },
      enduser: {
        "conversation:read": true,
        "conversation:write": true,
        "conversation:approve": false,
        "conversation:cancel": true,
        "conversation:commit": false,
        "conversation:list": true,
        "memory:write": false,
        "mcp:read": false,
      },
      portal_token_user: {
        "conversation:read": true,
        "conversation:write": true,
        "conversation:approve": false,
        "conversation:cancel": true,
        "conversation:commit": false,
        "conversation:list": false,
        "memory:write": false,
        "mcp:read": false,
      },
      metrics_scraper: {
        "conversation:read": false,
        "conversation:write": false,
        "conversation:approve": false,
        "conversation:cancel": false,
        "conversation:commit": false,
        "conversation:list": false,
        "memory:write": false,
        "mcp:read": false,
      },
    };

    const users_by_role: Record<string, string> = {};

    beforeAll(async () => {
      ctx = await createJourneyCtx("sk-cli-05-rbac-matrix");
      users_by_role.admin = ctx.userId;

      for (const roleName of [
        "member",
        "enduser",
        "portal_token_user",
        "metrics_scraper",
      ] as const) {
        const [u] = await ctx.db
          .insert(users)
          .values({
            tenant_id: ctx.tenantId,
            email: `${roleName}@sk-cli-05.test`,
            role_id: ctx.rbacRoleIds[roleName],
          })
          .returning();
        if (!u) throw new Error(`seed user failed for role ${roleName}`);
        users_by_role[roleName] = u.id;
      }
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    async function canQuery(principalId: string, permission: string): Promise<CanResult> {
      const res = await journeyFetch(ctx, "/v1/rbac/can", {
        method: "POST",
        body: JSON.stringify({ principal_id: principalId, permission }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as CanResult;
    }

    for (const [roleName, perms] of Object.entries(EXPECTED)) {
      for (const [permission, expected] of Object.entries(perms) as Array<
        [NewPermission, boolean]
      >) {
        test(`AC: role=${roleName} permission=${permission} expected=${expected ? "allow" : "deny"}`, async () => {
          const principalId = users_by_role[roleName];
          expect(principalId).toBeDefined();
          if (!principalId) return;
          const d = await canQuery(principalId, permission);
          if (d.allow !== expected) {
            throw new Error(
              `rbac matrix drift: role=${roleName} permission=${permission} ` +
                `expected=${expected ? "allow" : "deny"} got=${d.allow ? "allow" : "deny"} ` +
                `source=${d.source ?? "null"} reason=${d.reason ?? "null"}`,
            );
          }
          expect(d.allow).toBe(expected);
        });
      }
    }
  });
});
