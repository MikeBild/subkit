import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
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
function newKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function createUserWithKey(opsUserEmail: string, roleId: string) {
  const [u] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: opsUserEmail,
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
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
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
  }, JOURNEY_HOOK_TIMEOUT);
  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1-AC5: custom role end to end", async () => {
    const createRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "ops-engineer", description: "custom ops role" }),
    });
    expect(createRes.status).toBe(201);
    const role = (await createRes.json()) as { id: string; name: string };
    expect(role.name).toBe("ops-engineer");

    for (const p of ["workflow:read", "workflow:run", "workflow:write", "execution:read"]) {
      const r = await journeyFetch(ctx, `/v1/rbac/roles/${role.id}/permissions`, {
        method: "POST",
        body: JSON.stringify({ permission: p }),
      });
      expect(r.status).toBe(200);
    }

    const { user, apiKey } = await createUserWithKey(
      "ops@21.local",
      await emptyRoleId(ctx.db, ctx.tenantId),
    );

    const assignRes = await journeyFetch(ctx, `/v1/rbac/users/${user.id}/role`, {
      method: "POST",
      body: JSON.stringify({ role_id: role.id }),
    });
    expect(assignRes.status).toBe(200);

    const listRes = await asUser(apiKey, "/v1/workflows");
    if (listRes.status !== 200) {
      const body = await listRes.text();
      throw new Error(`list failed: ${listRes.status} ${body}`);
    }
    expect(listRes.status).toBe(200);
    const runRes = await asUser(apiKey, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect([200, 202]).toContain(runRes.status);

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

  test("AC7: a custom role cannot take or be renamed to a built-in name", async () => {
    const before = await journeyFetch(ctx, "/v1/rbac/roles");
    const countBefore = ((await before.json()) as { items: unknown[] }).items.length;

    const createRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "admin" }),
    });
    expect(createRes.status).toBe(409);
    expect(JSON.stringify(await createRes.json())).toContain("role_name_reserved");

    const after = await journeyFetch(ctx, "/v1/rbac/roles");
    expect(((await after.json()) as { items: unknown[] }).items.length).toBe(countBefore);

    const custom = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "renamer" }),
    });
    expect(custom.status).toBe(201);
    const { id } = (await custom.json()) as { id: string };
    const renameRes = await journeyFetch(ctx, `/v1/rbac/roles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "admin" }),
    });
    expect(renameRes.status).toBe(409);
    expect(JSON.stringify(await renameRes.json())).toContain("role_name_reserved");
  });
});
