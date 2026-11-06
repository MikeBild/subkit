import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";

const GOLDEN_PATH = new URL("./fixtures/rbac.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let deniedUserId: string;
let memberUserId: string;
let adminRoleId: string;
let memberRoleId: string;
let foreignRoleId: string;
let foreignGroupId: string;
let foreignGrantId: string;

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<admin>")
    .replaceAll(memberUserId, "<member>")
    .replaceAll(deniedUserId, "<denied>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function created(path: string, body: unknown): Promise<string> {
  const res = await http("POST", path, body);
  if (res.status !== 201) throw new Error(`seed ${path} answered ${res.status}`);
  return (res.body as { id: string }).id;
}

async function auditTrail(): Promise<string[]> {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), like(auditLog.action, "rbac.%")));
  return rows.map((row) => normalize(row)).sort();
}

async function deniedTrail(): Promise<string[]> {
  const rows = await ctx.db
    .select({
      action: auditLog.action,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.result, "denied")));
  return rows.map((row) => normalize(row)).sort();
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_rbac_golden");
  adminRoleId = await builtinRoleId(ctx.db, "admin");
  memberRoleId = await builtinRoleId(ctx.db, "member");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-rbac@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedUserId = denied.id;
  const [member] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: "member-rbac@test.local", role_id: memberRoleId })
    .returning();
  if (!member) throw new Error("member user insert returned no row");
  memberUserId = member.id;
  const rand = createDeterministicHexFactory(0x7b_ac)(16);
  deniedKey = `wf_live_${rand}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      denied.id,
      deniedKey.slice(0, 12),
      createHash("sha256").update(deniedKey).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  const foreign = await seedTenant(ctx.db);
  const { createRole, createGroup, grantResource } = await import("../../../rbac/index.ts");
  foreignRoleId = (await createRole(ctx.db, foreign.id, "foreign-role")).id;
  foreignGroupId = (await createGroup(ctx.db, foreign.id, "foreign-group")).id;
  foreignGrantId = (
    await grantResource(ctx.db, {
      tenant_id: foreign.id,
      subject_type: "group",
      subject_id: foreignGroupId,
      resource_type: "workflow",
      resource_id: "5eed0000-0000-4000-8000-00000000f001",
      permission: "workflow:read",
      granted_by: null,
      expires_at: null,
    })
  ).id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("rbac operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the body is validated on every rbac route", async () => {
    const id = MISSING;
    const calls: [string, string, string, unknown?][] = [
      ["permissions.list", "GET", "/v1/rbac/permissions"],
      ["roles.list", "GET", "/v1/rbac/roles"],
      ["roles.get", "GET", `/v1/rbac/roles/${id}`],
      ["roles.create", "POST", "/v1/rbac/roles", { name: 1 }],
      ["roles.patch", "PATCH", `/v1/rbac/roles/${id}`, { name: 1 }],
      ["roles.delete", "DELETE", `/v1/rbac/roles/${id}`],
      ["roles.grant", "POST", `/v1/rbac/roles/${id}/permissions`, { permission: 1 }],
      ["roles.revoke", "DELETE", `/v1/rbac/roles/${id}/permissions/workflow:read`],
      ["roles.assign", "POST", `/v1/rbac/users/${id}/role`, { role_id: 1 }],
      ["grants.list", "GET", "/v1/rbac/grants"],
      ["grants.create", "POST", "/v1/rbac/grants", { subject_type: "nobody" }],
      ["grants.delete", "DELETE", `/v1/rbac/grants/${id}`],
      ["groups.list", "GET", "/v1/rbac/groups"],
      ["groups.create", "POST", "/v1/rbac/groups", { name: 1 }],
      ["groups.patch", "PATCH", `/v1/rbac/groups/${id}`, { name: 1 }],
      ["groups.delete", "DELETE", `/v1/rbac/groups/${id}`],
      ["groups.member.add", "POST", `/v1/rbac/groups/${id}/members/${id}`],
      ["groups.member.remove", "DELETE", `/v1/rbac/groups/${id}/members/${id}`],
      ["groups.role.assign", "POST", `/v1/rbac/groups/${id}/roles/${id}`],
      ["groups.role.revoke", "DELETE", `/v1/rbac/groups/${id}/roles/${id}`],
      ["can", "POST", "/v1/rbac/can", { principal_id: 1 }],
    ];
    for (const [name, method, path, body] of calls) {
      record(`http.denied.${name}`, await http(method, path, body, deniedKey));
    }
    record("http.denied.audit", await deniedTrail());
  });

  test("permissions and roles", async () => {
    const permissions = await http("GET", "/v1/rbac/permissions");
    record("http.permissions.list.status", permissions.status);
    record("http.permissions.list.count", (permissions.body as { items: unknown[] }).items.length);
    record(
      "http.permissions.list.sample",
      (permissions.body as { items: { name: string }[] }).items.filter((p) =>
        p.name.startsWith("rbac:"),
      ),
    );
    record("http.roles.create.invalid", await http("POST", "/v1/rbac/roles", { name: 1 }));
    const customId = await created("/v1/rbac/roles", { name: "reviewer", description: "Reads" });
    record("http.roles.get", await http("GET", `/v1/rbac/roles/${customId}`));
    record("http.roles.get.missing", await http("GET", `/v1/rbac/roles/${MISSING}`));
    record("http.roles.get.foreign", await http("GET", `/v1/rbac/roles/${foreignRoleId}`));
    record("http.roles.get.invalid", await http("GET", "/v1/rbac/roles/not-a-uuid"));
    record(
      "http.roles.patch",
      await http("PATCH", `/v1/rbac/roles/${customId}`, { description: null }),
    );
    record(
      "http.roles.patch.builtin",
      await http("PATCH", `/v1/rbac/roles/${adminRoleId}`, { name: "boss" }),
    );
    record(
      "http.roles.patch.missing",
      await http("PATCH", `/v1/rbac/roles/${MISSING}`, { name: "x" }),
    );
    record(
      "http.roles.grant",
      await http("POST", `/v1/rbac/roles/${customId}/permissions`, {
        permission: "workflow:read",
      }),
    );
    record(
      "http.roles.grant.unknown",
      await http("POST", `/v1/rbac/roles/${customId}/permissions`, { permission: "nope:nope" }),
    );
    record(
      "http.roles.grant.builtin",
      await http("POST", `/v1/rbac/roles/${adminRoleId}/permissions`, {
        permission: "workflow:read",
      }),
    );
    record(
      "http.roles.grant.missing",
      await http("POST", `/v1/rbac/roles/${MISSING}/permissions`, {
        permission: "workflow:read",
      }),
    );
    record("http.roles.get.granted", await http("GET", `/v1/rbac/roles/${customId}`));
    record(
      "http.roles.revoke",
      await http("DELETE", `/v1/rbac/roles/${customId}/permissions/workflow:read`),
    );
    record(
      "http.roles.revoke.builtin",
      await http("DELETE", `/v1/rbac/roles/${adminRoleId}/permissions/workflow:read`),
    );
    record(
      "http.roles.revoke.missing",
      await http("DELETE", `/v1/rbac/roles/${MISSING}/permissions/workflow:read`),
    );
    record(
      "http.roles.revoke.foreign",
      await http("DELETE", `/v1/rbac/roles/${foreignRoleId}/permissions/workflow:read`),
    );
    record(
      "http.roles.assign",
      await http("POST", `/v1/rbac/users/${memberUserId}/role`, { role_id: customId }),
    );
    record(
      "http.roles.assign.last_admin",
      await http("POST", `/v1/rbac/users/${ctx.userId}/role`, { role_id: memberRoleId }),
    );
    record(
      "http.roles.assign.unknown_role",
      await http("POST", `/v1/rbac/users/${memberUserId}/role`, { role_id: MISSING }),
    );
    record(
      "http.roles.assign.foreign_role",
      await http("POST", `/v1/rbac/users/${memberUserId}/role`, { role_id: foreignRoleId }),
    );
    record(
      "http.roles.assign.missing_user",
      await http("POST", `/v1/rbac/users/${MISSING}/role`, { role_id: memberRoleId }),
    );
    record("http.roles.list", await http("GET", "/v1/rbac/roles"));
    record("http.roles.delete.in_use", await http("DELETE", `/v1/rbac/roles/${customId}`));
    record("http.roles.delete.builtin", await http("DELETE", `/v1/rbac/roles/${adminRoleId}`));
    record("http.roles.delete.missing", await http("DELETE", `/v1/rbac/roles/${MISSING}`));
    record("http.roles.delete.foreign", await http("DELETE", `/v1/rbac/roles/${foreignRoleId}`));
    await http("POST", `/v1/rbac/users/${memberUserId}/role`, { role_id: memberRoleId });
    record("http.roles.delete", await http("DELETE", `/v1/rbac/roles/${customId}`));
    record("http.roles.get.deleted", await http("GET", `/v1/rbac/roles/${customId}`));
  });

  test("grants", async () => {
    const groupId = await created("/v1/rbac/groups", { name: "grantees" });
    const body = {
      subject_type: "group",
      subject_id: groupId,
      resource_type: "workflow",
      resource_id: "5eed0000-0000-4000-8000-00000000a001",
      permission: "workflow:read",
    };
    const grant = await http("POST", "/v1/rbac/grants", body);
    record("http.grants.create", grant);
    record(
      "http.grants.create.unknown",
      await http("POST", "/v1/rbac/grants", { ...body, permission: "nope:nope" }),
    );
    record(
      "http.grants.create.expiring",
      await http("POST", "/v1/rbac/grants", {
        ...body,
        resource_id: "5eed0000-0000-4000-8000-00000000a002",
        expires_at: "2031-01-02T03:04:05.000Z",
      }),
    );
    record("http.grants.list", await http("GET", "/v1/rbac/grants"));
    const grantId = (grant.body as { id: string }).id;
    record("http.grants.delete", await http("DELETE", `/v1/rbac/grants/${grantId}`));
    record("http.grants.delete.missing", await http("DELETE", `/v1/rbac/grants/${grantId}`));
    record("http.grants.delete.foreign", await http("DELETE", `/v1/rbac/grants/${foreignGrantId}`));
    record("http.grants.delete.invalid", await http("DELETE", "/v1/rbac/grants/not-a-uuid"));
  });

  test("groups", async () => {
    record("http.groups.create.invalid", await http("POST", "/v1/rbac/groups", {}));
    const groupId = await created("/v1/rbac/groups", { name: "ops", description: "Operators" });
    record(
      "http.groups.patch",
      await http("PATCH", `/v1/rbac/groups/${groupId}`, { name: "ops-team" }),
    );
    record(
      "http.groups.patch.missing",
      await http("PATCH", `/v1/rbac/groups/${MISSING}`, { name: "x" }),
    );
    record(
      "http.groups.patch.foreign",
      await http("PATCH", `/v1/rbac/groups/${foreignGroupId}`, { name: "x" }),
    );
    const member = `/v1/rbac/groups/${groupId}/members/${memberUserId}`;
    record("http.groups.member.add", await http("POST", member));
    record("http.groups.member.add.again", await http("POST", member));
    record(
      "http.groups.member.add.missing_group",
      await http("POST", `/v1/rbac/groups/${MISSING}/members/${memberUserId}`),
    );
    record(
      "http.groups.member.add.foreign_group",
      await http("POST", `/v1/rbac/groups/${foreignGroupId}/members/${memberUserId}`),
    );
    record(
      "http.groups.member.add.missing_user",
      await http("POST", `/v1/rbac/groups/${groupId}/members/${MISSING}`),
    );
    const role = `/v1/rbac/groups/${groupId}/roles/${memberRoleId}`;
    record("http.groups.role.assign", await http("POST", role));
    record("http.groups.role.assign.again", await http("POST", role));
    record(
      "http.groups.role.assign.missing_group",
      await http("POST", `/v1/rbac/groups/${MISSING}/roles/${memberRoleId}`),
    );
    record(
      "http.groups.role.assign.missing_role",
      await http("POST", `/v1/rbac/groups/${groupId}/roles/${MISSING}`),
    );
    record(
      "http.groups.role.assign.foreign_role",
      await http("POST", `/v1/rbac/groups/${groupId}/roles/${foreignRoleId}`),
    );
    record("http.groups.list", await http("GET", "/v1/rbac/groups"));
    record("http.groups.role.revoke", await http("DELETE", role));
    record("http.groups.role.revoke.again", await http("DELETE", role));
    record(
      "http.groups.role.revoke.foreign",
      await http("DELETE", `/v1/rbac/groups/${foreignGroupId}/roles/${memberRoleId}`),
    );
    record("http.groups.member.remove", await http("DELETE", member));
    record("http.groups.member.remove.again", await http("DELETE", member));
    record("http.groups.delete", await http("DELETE", `/v1/rbac/groups/${groupId}`));
    record("http.groups.delete.again", await http("DELETE", `/v1/rbac/groups/${groupId}`));
    record("http.groups.delete.foreign", await http("DELETE", `/v1/rbac/groups/${foreignGroupId}`));
  });

  test("can", async () => {
    record(
      "http.can.allow",
      await http("POST", "/v1/rbac/can", { principal_id: ctx.userId, permission: "rbac:read" }),
    );
    record(
      "http.can.deny",
      await http("POST", "/v1/rbac/can", {
        principal_id: deniedUserId,
        permission: "workflow:read",
        resource: { type: "workflow", id: "5eed0000-0000-4000-8000-00000000a001" },
      }),
    );
    record(
      "http.can.missing",
      await http("POST", "/v1/rbac/can", { principal_id: MISSING, permission: "rbac:read" }),
    );
    record("http.can.invalid", await http("POST", "/v1/rbac/can", { principal_id: 1 }));
  });

  test("every state change wrote its audit row", async () => {
    record("http.audit", await auditTrail());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
