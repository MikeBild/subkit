import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../../audit/audit.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createInvite } from "../../../identity/provisioning.ts";
import { createSystemAccount, issueApiKey, issuePortalToken } from "../../../identity/service.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";

export interface IdentityWorld {
  readonly ctx: HttpTestServer;
  readonly deniedKey: string;
  readonly deniedUserId: string;
  readonly memberKey: string;
  readonly memberUserId: string;
  readonly operatorKey: string;
  readonly operatorUserId: string;
  readonly foreignTenantId: string;
  readonly foreignUserId: string;
  readonly foreignApiKeyId: string;
  readonly foreignPortalTokenId: string;
  readonly foreignSystemAccountId: string;
  readonly foreignInviteId: string;
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export function normalizeIdentity(w: IdentityWorld, value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(w.ctx.tenantId, "<tenant>")
    .replaceAll(w.foreignTenantId, "<foreign-tenant>")
    .replaceAll(w.ctx.userId, "<admin>")
    .replaceAll(w.ctx.systemAccountId, "<bot>")
    .replaceAll(w.memberUserId, "<member>")
    .replaceAll(w.operatorUserId, "<operator>")
    .replaceAll(w.deniedUserId, "<denied>")
    .replaceAll(w.ctx.baseUrl, "<base>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(
      /"(prefix|plaintext_key|plaintext_token|api_key|token_prefix)":"[^"]*"/g,
      '"$1":"<secret>"',
    )
    .replace(/"t-operations_identity_golden"/g, '"<slug>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

export async function requestIdentity(
  w: IdentityWorld,
  method: string,
  path: string,
  body?: unknown,
  key = w.ctx.apiKey,
): Promise<Answer> {
  const res = await fetch(`${w.ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function identityAuditTrail(w: IdentityWorld, actions: string[]): Promise<string[]> {
  await _drainAuditWritesForTests(w.ctx.db);
  const rows = await w.ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, w.ctx.tenantId), inArray(auditLog.action, actions)));
  return rows.map((row) => normalizeIdentity(w, row)).sort();
}

async function seedKey(ctx: HttpTestServer, userId: string, seed: number): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      userId,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function seedUser(ctx: HttpTestServer, email: string, roleId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: roleId })
    .returning();
  if (!row) throw new Error(`seed ${email} returned no row`);
  return row.id;
}

export async function seedIdentityWorld(): Promise<IdentityWorld> {
  const ctx = await createHttpTestServer("operations_identity_golden");
  const deniedUserId = await seedUser(
    ctx,
    "denied-identity@test.local",
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  const deniedKey = await seedKey(ctx, deniedUserId, 0x1d_e0);
  const memberUserId = await seedUser(
    ctx,
    "member-identity@test.local",
    await builtinRoleId(ctx.db, "member"),
  );
  const memberKey = await seedKey(ctx, memberUserId, 0x1d_e1);
  const operatorRole = await createRole(ctx.db, ctx.tenantId, "identity-operator");
  for (const permission of [
    "identity:read",
    "identity:write",
    "api_key:read",
    "api_key:write",
    "api_key:rotate",
    "api_key:revoke",
    "portal_token:read",
    "portal_token:write",
    "portal_token:revoke",
  ]) {
    await grantPermissionToRole(ctx.db, ctx.tenantId, operatorRole.id, permission);
  }
  const operatorUserId = await seedUser(ctx, "operator-identity@test.local", operatorRole.id);
  const operatorKey = await seedKey(ctx, operatorUserId, 0x1d_e2);

  const foreign = await seedTenant(ctx.db);
  const foreignTenantId = foreign.id;
  const [foreignUser] = await ctx.db
    .insert(users)
    .values({
      tenant_id: foreign.id,
      email: "foreign-identity@test.local",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!foreignUser) throw new Error("foreign user insert returned no row");
  const foreignUserId = foreignUser.id;
  const foreignApiKeyId = (
    await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: foreign.id,
        owner_kind: "user",
        owner_id: foreignUser.id,
        actor_id: null,
      },
      ctx.db,
    )
  ).view.id;
  const foreignPortalTokenId = (
    await issuePortalToken(
      {
        tenant_id: foreign.id,
        user_id: "foreign-enduser",
        allowed_workflows: ["any"],
        actor_id: null,
        actor_kind: "system",
      },
      ctx.db,
    )
  ).view.id;
  const foreignSystemAccountId = (
    await createSystemAccount(
      { tenant_id: foreign.id, name: "foreign-bot", actor_id: null },
      ctx.db,
    )
  ).id;
  const foreignInviteId = (
    await createInvite(
      {
        issuer: { kind: "system" },
        tenant_id: foreign.id,
        user_id: foreignUser.id,
        actor_id: null,
        actor_kind: "system",
      },
      ctx.db,
    )
  ).view.id;
  return {
    ctx,
    deniedKey,
    deniedUserId,
    memberKey,
    memberUserId,
    operatorKey,
    operatorUserId,
    foreignTenantId,
    foreignUserId,
    foreignApiKeyId,
    foreignPortalTokenId,
    foreignSystemAccountId,
    foreignInviteId,
  };
}
