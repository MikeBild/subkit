import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { apiKeys, portalTokens, roles, systemAccounts, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { BUILTIN_ROLE_NAMES } from "../../rbac/seed.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey() {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

describe("an admin manages roles, grants, groups and scopes", () => {
  describe("a custom role", () => {
    let ctx: JourneyCtx;

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

      const duplicate = await journeyFetch(ctx, "/v1/rbac/roles", {
        method: "POST",
        body: JSON.stringify({ name: "renamer" }),
      });
      expect(duplicate.status).toBe(409);
      expect(JSON.stringify(await duplicate.json())).toContain("role_name_taken");
    });
  });

  describe("resource grants", () => {
    let ctx: JourneyCtx;

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

  describe("groups", () => {
    let ctx: JourneyCtx;

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
          role_id: await emptyRoleId(ctx.db, ctx.tenantId),
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

      const grpRes = await journeyFetch(ctx, "/v1/rbac/groups", {
        method: "POST",
        body: JSON.stringify({ name: "oncall" }),
      });
      expect(grpRes.status).toBe(201);
      const grp = (await grpRes.json()) as { id: string };
      groupId = grp.id;

      const rolesRes = await journeyFetch(ctx, "/v1/rbac/roles");
      const rolesBody = (await rolesRes.json()) as {
        items: Array<{ id: string; name: string; is_builtin: boolean }>;
      };
      const memberRole = rolesBody.items.find((r) => r.is_builtin && r.name === "member");
      expect(memberRole).toBeDefined();
      if (!memberRole) return;

      const assignRes = await journeyFetch(
        ctx,
        `/v1/rbac/groups/${groupId}/roles/${memberRole.id}`,
        {
          method: "POST",
        },
      );
      expect(assignRes.status).toBe(200);

      const addRes = await journeyFetch(ctx, `/v1/rbac/groups/${groupId}/members/${userId}`, {
        method: "POST",
      });
      expect(addRes.status).toBe(200);

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

  describe("system account scopes", () => {
    let ctx: JourneyCtx;

    async function seedSystemKey(name: string, builtinRoleName: string): Promise<string> {
      const roleRows = await ctx.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(isNull(roles.tenant_id), eq(roles.name, builtinRoleName)))
        .limit(1);
      const role_id = roleRows[0]?.id ?? null;
      const [acct] = await ctx.db
        .insert(systemAccounts)
        .values({ tenant_id: ctx.tenantId, name, role_id })
        .returning();
      const k = newKey();
      await ctx.db.insert(apiKeys).values({
        tenant_id: ctx.tenantId,
        system_account_id: acct!.id,
        prefix: k.prefix,
        token_sha256: k.hash,
        scopes: ["*"],
      });
      return k.plaintext;
    }

    let metricsKey = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("24-rbac-sys");
      metricsKey = await seedSystemKey("metrics-scraper-24", BUILTIN_ROLE_NAMES.METRICS_SCRAPER);
    }, JOURNEY_HOOK_TIMEOUT);
    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    async function req(key: string, path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${key}`);
      if (init.body && !headers.has("content-type"))
        headers.set("content-type", "application/json");
      return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
    }

    test("AC1: metrics_scraper cannot list workflows", async () => {
      const res = await req(metricsKey, "/v1/workflows");
      expect(res.status).toBe(403);
    });

    test("AC2: default-bot (admin) retains full access", async () => {
      const res = await req(ctx.apiKey, "/v1/workflows");
      expect(res.status).toBe(200);
    });
  });

  describe("MCP permissions", () => {
    const TEST_NOW_MS = getTestNow();

    let ctx: JourneyCtx;

    let workflowA = "";
    let portalUser = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("25-rbac-mcp");
      workflowA = (
        await seedWorkflow(ctx, {
          slug: "a",
          name: "A",
          steps: [{ id: "s1", kind: "transform", expression: '"a"' }],
        })
      ).id;
      await seedWorkflow(ctx, {
        slug: "b",
        name: "B",
        steps: [{ id: "s1", kind: "transform", expression: '"b"' }],
      });
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "portal@25",
          role_id: await builtinRoleId(ctx.db, "enduser"),
        })
        .returning();
      portalUser = u!.id;
      const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
      const plaintext = `wf_portal_${rand}`;
      await ctx.db.insert(portalTokens).values({
        tenant_id: ctx.tenantId,
        enduser_ref: portalUser,
        prefix: plaintext.slice(0, 12),
        token_sha256: sha256Hex(plaintext),
        allowed_workflows: [workflowA],
        expires_at: new Date(TEST_NOW_MS + 3600_000),
      });
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    async function canQuery(body: unknown): Promise<{ allow: boolean; source: string | null }> {
      const res = await journeyFetch(ctx, "/v1/rbac/can", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return (await res.json()) as { allow: boolean; source: string | null };
    }

    test("AC3: member-role user is allowed connector:read", async () => {
      const memberRes = await journeyFetch(ctx, "/v1/rbac/roles");
      const body = (await memberRes.json()) as {
        items: Array<{ id: string; name: string; is_builtin: boolean }>;
      };
      const member = body.items.find((r) => r.is_builtin && r.name === "member");
      expect(member).toBeDefined();
      if (!member) return;
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "member@25",
          role_id: member.id,
        })
        .returning();

      const d = await canQuery({
        principal_id: u!.id,
        permission: "connector:read",
      });
      expect(d.allow).toBe(true);
    });

    test("AC4: bare role user is denied connector:read", async () => {
      const bareRes = await journeyFetch(ctx, "/v1/rbac/roles", {
        method: "POST",
        body: JSON.stringify({ name: "bare-25" }),
      });
      const bare = (await bareRes.json()) as { id: string };
      const [u] = await ctx.db
        .insert(users)
        .values({
          tenant_id: ctx.tenantId,
          email: "bare@25",
          role_id: bare.id,
        })
        .returning();
      const d = await canQuery({
        principal_id: u!.id,
        permission: "connector:read",
      });
      expect(d.allow).toBe(false);
    });
  });
});
