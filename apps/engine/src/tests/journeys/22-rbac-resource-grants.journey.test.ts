import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, roles, users } from "../../db/schema/index.ts";
import { BUILTIN_ROLE_NAMES } from "../../rbac/seed.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

describe("journey: rbac resource grants", () => {
  let workflowX = "";
  let workflowY = "";
  let memberUserId = "";
  let memberApiKey = "";
  let grantId = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("22-rbac-grants");
    const x = await seedWorkflow(ctx, {
      slug: "xwf",
      name: "X",
      steps: [{ id: "s1", kind: "transform", expression: '"x"' }],
    });
    workflowX = x.id;
    const y = await seedWorkflow(ctx, {
      slug: "ywf",
      name: "Y",
      steps: [{ id: "s1", kind: "transform", expression: '"y"' }],
    });
    workflowY = y.id;

    const memberRole = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.tenant_id), eq(roles.name, BUILTIN_ROLE_NAMES.MEMBER)))
      .limit(1);
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member@22.local",
        role_id: memberRole[0]!.id,
      })
      .returning();
    memberUserId = u!.id;
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    const plaintext = `wf_live_${rand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: u!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: sha256Hex(plaintext),
      scopes: ["*"],
    });
    memberApiKey = plaintext;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function asMember(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${memberApiKey}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
  }

  test("AC1-AC3: scoped workflow:run grant", async () => {
    const createRole = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "bare", description: "no perms" }),
    });
    expect(createRole.status).toBe(201);
    const bare = (await createRole.json()) as { id: string };
    await journeyFetch(ctx, `/v1/rbac/users/${memberUserId}/role`, {
      method: "POST",
      body: JSON.stringify({ role_id: bare.id }),
    });

    const preX = await asMember("/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowX, input: {} }),
    });
    expect(preX.status).toBe(403);

    const grant = await journeyFetch(ctx, "/v1/rbac/grants", {
      method: "POST",
      body: JSON.stringify({
        subject_type: "user",
        subject_id: memberUserId,
        resource_type: "workflow",
        resource_id: workflowX,
        permission: "workflow:run",
      }),
    });
    expect(grant.status).toBe(201);
    const grantBody = (await grant.json()) as { id: string };
    grantId = grantBody.id;

    const postX = await asMember("/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowX, input: {} }),
    });
    expect([200, 202]).toContain(postX.status);

    const postY = await asMember("/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowY, input: {} }),
    });
    expect(postY.status).toBe(403);
  });

  test("AC4: revoke the grant", async () => {
    const revoke = await journeyFetch(ctx, `/v1/rbac/grants/${grantId}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);
    const postX = await asMember("/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowX, input: {} }),
    });
    expect(postX.status).toBe(403);
  });
});
