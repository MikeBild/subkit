// User story: As a platform operator, I need every built-in role to
// grant exactly the conversation:*, memory:*, and mcp:* permissions
// the sk-cli rollout requires — no more, no less. This file is the
// guardrail against silent regressions in the RBAC seed map that
// would either lock endusers out of chat or over-grant commit rights
// to portal-token principals.
//
// Acceptance criteria:
//
//   AC1. admin — allowed every new conversation:*/memory:*/mcp:* perm.
//   AC2. member — allowed every new conversation:*/memory:*/mcp:* perm.
//   AC3. enduser — allowed conversation:read/write/cancel/list; denied
//        conversation:approve, conversation:commit, memory:write,
//        mcp:read (endusers chat against approved workflows only, they
//        cannot approve their own drafts, commit, attach memory, or
//        introspect MCP).
//   AC4. portal_token_user — allowed conversation:read/write/cancel;
//        denied conversation:list, conversation:approve,
//        conversation:commit, memory:write, mcp:read.
//   AC5. tunnel_agent / metrics_scraper — denied every new perm (they
//        are machine roles, not chat participants).
//
// Audit coverage:
//   - policy.denied rows are not asserted here — the /rbac/can endpoint
//     does not emit denials, only the middleware does. A separate audit
//     journey asserts the middleware contract.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { users } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

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

/**
 * Expected allow/deny decisions for every (role, permission) pair.
 * Hand-maintained; the test fails loudly if this map and the seeder
 * drift apart.
 */
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
  tunnel_agent: {
    "conversation:read": false,
    "conversation:write": false,
    "conversation:approve": false,
    "conversation:cancel": false,
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
  // Per-role user rows. Admin is the journey user itself.
  const users_by_role: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-05-rbac-matrix");
    users_by_role.admin = ctx.userId;

    // For every non-admin built-in role, seed a dedicated user row and
    // pin role_id so the evaluator sees the exact role we intend to test.
    for (const roleName of [
      "member",
      "enduser",
      "portal_token_user",
      "tunnel_agent",
      "metrics_scraper",
    ] as const) {
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: `${roleName}@sk-cli-05.test`,
          // The legacy enum column is constrained to admin/member/enduser,
          // so we pick the closest legacy value for rows whose built-in
          // role has no enum equivalent. The evaluator only reads role_id.
          role: roleName === "member" ? "member" : "enduser",
          role_id: ctx.rbacRoleIds[roleName],
        })
        .returning();
      if (!u) throw new Error(`seed user failed for role ${roleName}`);
      users_by_role[roleName] = u.id;
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

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
