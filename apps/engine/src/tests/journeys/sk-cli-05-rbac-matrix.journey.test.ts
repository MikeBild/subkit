import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { users } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

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

describe("journey: sk-cli rbac matrix", () => {
  const users_by_role: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-05-rbac-matrix");
    users_by_role.admin = ctx.userId;

    for (const roleName of ["member", "enduser", "portal_token_user", "metrics_scraper"] as const) {
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
    for (const [permission, expected] of Object.entries(perms) as Array<[NewPermission, boolean]>) {
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
