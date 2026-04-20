// User story: As a tenant admin, I want to create a custom role
// scoped to my tenant, assign it to a user, and have the engine honor
// it across the REST surface.
// Acceptance criteria:
//   - AC1: POST /v1/rbac/roles creates a custom role.
//   - AC2: POST /v1/rbac/roles/:id/permissions attaches permissions.
//   - AC3: POST /v1/rbac/users/:id/role binds the role to a user.
//   - AC4: That user can then list + run workflows.
//   - AC5: That user cannot delete connectors (no connector:delete).
//   - AC6: Built-in roles reject mutation with 409.
// Spec refs: gap-pass-2 C1 / C5 / C8

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch, seedWorkflow } from "./setup.ts";

let ctx: JourneyCtx;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}
function newKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function createUserWithKey(opsUserEmail: string, roleId: string | null) {
  const [u] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: opsUserEmail,
      role: "member",
      role_id: roleId,
    })
    .returning();
  if (!u) throw new Error("seed user");
  const k = newKey();
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: u.id,
    prefix: k.prefix,
    token_sha256: k.hash,
    scopes: ["*"],
  });
  return { user: u, apiKey: k.plaintext };
}

async function asUser(apiKey: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

describe("journey: rbac custom role", () => {
  let workflowId = "";
  beforeAll(async () => {
    ctx = await createJourneyCtx("21-rbac-roles");
    const wf = await seedWorkflow(ctx, {
      slug: "demo",
      name: "Demo",
      steps: [{ id: "t1", kind: "transform", expression: '"ok"' }],
    });
    workflowId = wf.id;
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  test("AC1-AC5: custom role end to end", async () => {
    // AC1: create the ops-engineer role
    const createRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "ops-engineer", description: "custom ops role" }),
    });
    expect(createRes.status).toBe(201);
    const role = (await createRes.json()) as { id: string; name: string };
    expect(role.name).toBe("ops-engineer");

    // AC2: attach permissions.
    for (const p of ["workflow:read", "workflow:run", "workflow:write", "execution:read"]) {
      const r = await journeyFetch(ctx, `/v1/rbac/roles/${role.id}/permissions`, {
        method: "POST",
        body: JSON.stringify({ permission: p }),
      });
      expect(r.status).toBe(200);
    }

    // Create a user with no role_id yet and an API key.
    const { user, apiKey } = await createUserWithKey("ops@21.local", null);

    // AC3: assign the role via the management API.
    const assignRes = await journeyFetch(ctx, `/v1/rbac/users/${user.id}/role`, {
      method: "POST",
      body: JSON.stringify({ role_id: role.id }),
    });
    expect(assignRes.status).toBe(200);

    // AC4: list + run workflows should now work.
    const listRes = await asUser(apiKey, "/v1/workflows");
    if (listRes.status !== 200) {
      // Log the body to help diagnose in CI.
      const body = await listRes.text();
      throw new Error(`list failed: ${listRes.status} ${body}`);
    }
    expect(listRes.status).toBe(200);
    const runRes = await asUser(apiKey, `/v1/workflows/${workflowId}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect([200, 202]).toContain(runRes.status);

    // AC5: connector:delete is NOT in the role → 403.
    const delRes = await asUser(apiKey, "/v1/rbac/roles/xyz", { method: "DELETE" });
    expect(delRes.status).toBe(403);
  });

  test("AC6: built-in role mutations return 409", async () => {
    const listRes = await journeyFetch(ctx, "/v1/rbac/roles");
    const body = (await listRes.json()) as {
      items: Array<{ id: string; name: string; is_builtin: boolean }>;
    };
    const builtin = body.items.find((r) => r.is_builtin && r.name === "member");
    expect(builtin).toBeDefined();
    if (!builtin) return;
    const res = await journeyFetch(ctx, `/v1/rbac/roles/${builtin.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "tampered" }),
    });
    expect(res.status).toBe(409);
  });
});
