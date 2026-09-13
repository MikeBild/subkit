// User story: As an operator, I want to ask `POST /v1/rbac/can`
// directly so my dashboards and CI can verify permission decisions
// without minting keys and hitting every route.
// Acceptance criteria:
//   - AC1-AC15: A matrix of (principal, permission, resource) cases
//               produces the expected allow/deny decisions.
//   - AC16: Built-in admin always wins.
// Spec refs: gap-pass-2 C4 / C8

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { roles, users } from "../../db/schema/index.ts";
import { BUILTIN_ROLE_NAMES } from "../../rbac/seed.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let adminUserId = "";
let memberUserId = "";
let bareUserId = "";
let workflowId = "";

async function findBuiltin(name: string): Promise<string | null> {
  const r = await ctx.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, name)))
    .limit(1);
  return r[0]?.id ?? null;
}

describe("journey: rbac can query", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("26-rbac-can");
    adminUserId = ctx.userId;
    const memberRoleId = await findBuiltin(BUILTIN_ROLE_NAMES.MEMBER);
    const [m] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "m@26",
        role: "member",
        role_id: memberRoleId,
      })
      .returning();
    memberUserId = m!.id;

    const bareRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "bare-26" }),
    });
    const bare = (await bareRes.json()) as { id: string };
    const [b] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "b@26",
        role: "enduser",
        role_id: bare.id,
      })
      .returning();
    bareUserId = b!.id;

    const wf = await seedWorkflow(ctx, {
      slug: "w",
      name: "W",
      steps: [{ id: "s1", kind: "transform", expression: '"w"' }],
    });
    workflowId = wf.id;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function can(
    principal_id: string,
    permission: string,
    resource?: { type: string; id: string },
  ) {
    const body: Record<string, unknown> = { principal_id, permission };
    if (resource) body.resource = resource;
    const res = await journeyFetch(ctx, "/v1/rbac/can", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await res.json()) as { allow: boolean; source: string | null };
  }

  test("matrix of decisions", async () => {
    // AC16: admin short-circuit.
    expect((await can(adminUserId, "workflow:run")).allow).toBe(true);
    expect((await can(adminUserId, "rbac:write")).allow).toBe(true);
    expect((await can(adminUserId, "audit:read")).allow).toBe(true);

    // Member positive cases.
    expect((await can(memberUserId, "workflow:read")).allow).toBe(true);
    expect((await can(memberUserId, "workflow:run")).allow).toBe(true);
    expect((await can(memberUserId, "execution:read")).allow).toBe(true);
    expect((await can(memberUserId, "connector:read")).allow).toBe(true);
    expect((await can(memberUserId, "skill:read")).allow).toBe(true);
    // Members manage the lifecycle of operational resources they
    // create — including delete. Pre-fix the blanket :delete deny
    // produced session 0aed284f's "I can't delete things I just
    // created" failure mode.
    expect((await can(memberUserId, "workflow:delete")).allow).toBe(true);
    expect((await can(memberUserId, "connector:delete")).allow).toBe(true);

    // Member deny cases — secrets, RBAC mutations, audit reads,
    // api_key lifecycle stay admin-only.
    expect((await can(memberUserId, "credential:delete")).allow).toBe(false);
    expect((await can(memberUserId, "credential:write")).allow).toBe(false);
    expect((await can(memberUserId, "rbac:write")).allow).toBe(false);
    expect((await can(memberUserId, "audit:read")).allow).toBe(false);
    expect((await can(memberUserId, "api_key:revoke")).allow).toBe(false);

    // Bare role deny cases.
    expect((await can(bareUserId, "workflow:read")).allow).toBe(false);
    expect((await can(bareUserId, "rbac:read")).allow).toBe(false);

    // Resource-scoped lookups.
    const wfRead = await can(memberUserId, "workflow:read", {
      type: "workflow",
      id: workflowId,
    });
    expect(wfRead.allow).toBe(true);
  });
});
