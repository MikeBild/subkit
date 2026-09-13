// User story: As an admin, I want to bundle users into a group and
// assign a role to the group so new members inherit access
// transitively.
// Acceptance criteria:
//   - AC1: Admin creates group `oncall`, adds a member, assigns `member` role.
//   - AC2: The group member inherits `workflow:read` via the group path.
//   - AC3: Removing the member revokes access.
// Spec refs: gap-pass-2 C3 / C4 / C8

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { apiKeys, users } from "../../db/schema/index.ts";
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

describe("journey: rbac groups", () => {
  let userId = "";
  let apiKey = "";
  let groupId = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("23-rbac-groups");
    await seedWorkflow(ctx, {
      slug: "g",
      name: "G",
      steps: [{ id: "s1", kind: "transform", expression: '"g"' }],
    });
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "group@23.local",
        role: "member",
        // deliberately NULL role_id — access should flow via the group.
        role_id: null,
      })
      .returning();
    userId = u!.id;
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    const plaintext = `wf_live_${rand}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: u!.id,
      prefix: plaintext.slice(0, 12),
      token_sha256: sha256Hex(plaintext),
      scopes: ["*"],
    });
    apiKey = plaintext;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function asUser(path: string) {
    return fetch(`${ctx.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
  }

  test("AC1-AC2: group role assignment grants transitive access", async () => {
    // Initial state: user is not in a group and has no role_id. The
    // evaluator's legacy-enum fallback resolves to the built-in
    // `member` role (tests inherit the enum value `member`). To
    // isolate the group path we bind the user to a bare custom role.
    const roleRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "bare-23", description: "no perms" }),
    });
    const bare = (await roleRes.json()) as { id: string };
    await journeyFetch(ctx, `/v1/rbac/users/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role_id: bare.id }),
    });

    const preList = await asUser("/v1/workflows");
    expect(preList.status).toBe(403);

    // AC1: create group + assign member role.
    const grpRes = await journeyFetch(ctx, "/v1/rbac/groups", {
      method: "POST",
      body: JSON.stringify({ name: "oncall" }),
    });
    expect(grpRes.status).toBe(201);
    const grp = (await grpRes.json()) as { id: string };
    groupId = grp.id;

    // Find the member built-in role id.
    const rolesRes = await journeyFetch(ctx, "/v1/rbac/roles");
    const rolesBody = (await rolesRes.json()) as {
      items: Array<{ id: string; name: string; is_builtin: boolean }>;
    };
    const memberRole = rolesBody.items.find((r) => r.is_builtin && r.name === "member");
    expect(memberRole).toBeDefined();
    if (!memberRole) return;

    // Assign the role to the group.
    const assignRes = await journeyFetch(ctx, `/v1/rbac/groups/${groupId}/roles/${memberRole.id}`, {
      method: "POST",
    });
    expect(assignRes.status).toBe(200);

    // Add the user as a member of the group.
    const addRes = await journeyFetch(ctx, `/v1/rbac/groups/${groupId}/members/${userId}`, {
      method: "POST",
    });
    expect(addRes.status).toBe(200);

    // AC2: user can now list workflows via the group path.
    const postList = await asUser("/v1/workflows");
    expect(postList.status).toBe(200);
  });

  test("AC3: removing the member revokes access", async () => {
    const removeRes = await journeyFetch(ctx, `/v1/rbac/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    });
    expect(removeRes.status).toBe(204);
    const list = await asUser("/v1/workflows");
    expect(list.status).toBe(403);
  });
});
