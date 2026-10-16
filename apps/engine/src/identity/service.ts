import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import type { PrincipalKind } from "../auth/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  apiKeys,
  portalTokens,
  roles,
  sessions,
  systemAccounts,
  tenants,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { now } from "../utils/clock.ts";
import { generateKey, hashKey } from "./api-key.ts";
import { assertAdminRemains } from "./last-admin.ts";
import { generatePortalToken } from "./portal-token.ts";

export const SESSION_SLIDING_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ListOptions {
  limit?: number;
  offset?: number;
  productId?: string;
}

export interface UserIdentitySummary {
  user_id: string;
  provider_id: string;
  product_id: string | null;
  last_seen_at: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export async function getTenant(tenantId: string, exec?: Executor) {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), isNull(tenants.deleted_at)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTenantsForPrincipal(tenantId: string, exec?: Executor) {
  const t = await getTenant(tenantId, exec);
  return t ? [t] : [];
}

function userTenantConds(tenantId: string, productId: string | undefined) {
  return and(
    eq(users.tenant_id, tenantId),
    isNull(users.deleted_at),
    productId === undefined
      ? undefined
      : sql`EXISTS (SELECT 1 FROM ${userIdentities} WHERE ${userIdentities.tenant_id} = ${tenantId} AND ${userIdentities.user_id} = ${users.id} AND ${userIdentities.product_id} = ${productId})`,
  );
}

export async function listUsers(tenantId: string, opts: ListOptions = {}, exec?: Executor) {
  const db = exec ?? getDb();
  return db
    .select()
    .from(users)
    .where(userTenantConds(tenantId, opts.productId))
    .orderBy(desc(users.created_at))
    .limit(clampLimit(opts.limit))
    .offset(opts.offset ?? 0);
}

export async function countUsers(
  tenantId: string,
  exec?: Executor,
  opts: Pick<ListOptions, "productId"> = {},
): Promise<number> {
  const db = exec ?? getDb();
  const [row] = await db
    .select({ total: count() })
    .from(users)
    .where(userTenantConds(tenantId, opts.productId));
  return row?.total ?? 0;
}

export async function listIdentitiesByUser(
  exec: Executor,
  tenantId: string,
  userIds: string[],
): Promise<UserIdentitySummary[]> {
  if (userIds.length === 0) return [];
  return exec
    .select({
      user_id: userIdentities.user_id,
      provider_id: userIdentities.provider_id,
      product_id: userIdentities.product_id,
      last_seen_at: userIdentities.last_seen_at,
    })
    .from(userIdentities)
    .where(and(eq(userIdentities.tenant_id, tenantId), inArray(userIdentities.user_id, userIds)))
    .orderBy(desc(userIdentities.last_seen_at));
}

export async function getUser(tenantId: string, id: string, exec?: Executor) {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), eq(users.id, id), isNull(users.deleted_at)))
    .limit(1);
  return rows[0] ?? null;
}

export type UserRole = "admin" | "member" | "enduser";
export type UserStatus = "invited" | "active" | "disabled";

export interface UpdateUserInput {
  tenant_id: string;
  id: string;
  role?: UserRole;
  role_id?: string;
  display_name?: string | null;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

export async function updateUser(input: UpdateUserInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(users)
      .where(
        and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.id), isNull(users.deleted_at)),
      )
      .limit(1);
    const before = current[0];
    if (!before) return null;

    const patch: { role_id?: string; display_name?: string | null; updated_at?: Date } = {};
    if (input.role_id !== undefined) patch.role_id = input.role_id;
    else if (input.role !== undefined) patch.role_id = await builtinRoleId(tx, input.role);
    if (input.display_name !== undefined) patch.display_name = input.display_name;

    const nextRoleId = patch.role_id ?? before.role_id;
    const roleChanged = patch.role_id !== undefined && patch.role_id !== before.role_id;
    const profileChanged =
      patch.display_name !== undefined && patch.display_name !== before.display_name;
    if (!roleChanged && !profileChanged) return before;
    if (roleChanged) {
      patch.updated_at = new Date(now());
      const [assigned] = await tx
        .select({ name: roles.name })
        .from(roles)
        .where(
          and(
            eq(roles.id, nextRoleId),
            or(isNull(roles.tenant_id), eq(roles.tenant_id, input.tenant_id)),
          ),
        )
        .limit(1);
      await assertAdminRemains(tx, {
        tenant_id: input.tenant_id,
        user_id: input.id,
        nextEffectiveRole: assigned?.name ?? null,
      });
    }
    if (profileChanged && !roleChanged) patch.updated_at = new Date(now());

    const [row] = await tx
      .update(users)
      .set(patch)
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.id)))
      .returning();
    if (!row) return null;
    if (roleChanged) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
          action: AuditAction.USER_ROLE_CHANGED,
          resource_type: "user",
          resource_id: row.id,
          result: "success",
          before: { role_id: before.role_id },
          after: { role_id: row.role_id },
          metadata: { email: row.email },
        },
        tx,
      );
    }
    if (profileChanged) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
          action: AuditAction.USER_PROFILE_UPDATED,
          resource_type: "user",
          resource_id: row.id,
          result: "success",
          before: { display_name: before.display_name },
          after: { display_name: row.display_name },
          metadata: { email: row.email },
        },
        tx,
      );
    }
    return row;
  });
}

export async function listSystemAccounts(
  tenantId: string,
  opts: ListOptions = {},
  exec?: Executor,
) {
  const db = exec ?? getDb();
  return db
    .select()
    .from(systemAccounts)
    .where(and(eq(systemAccounts.tenant_id, tenantId), isNull(systemAccounts.deleted_at)))
    .orderBy(desc(systemAccounts.created_at))
    .limit(clampLimit(opts.limit))
    .offset(opts.offset ?? 0);
}

export interface CreateSystemAccountInput {
  tenant_id: string;
  name: string;
  description?: string | null;
  actor_kind?: PrincipalKind;
  actor_id: string | null;
}

export async function createSystemAccount(input: CreateSystemAccountInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(systemAccounts)
      .values({
        tenant_id: input.tenant_id,
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    assertInsertRow(row, "system_accounts");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
        action: AuditAction.SYSTEM_ACCOUNT_CREATED,
        resource_type: "system_account",
        resource_id: row.id,
        result: "success",
        metadata: { name: row.name },
      },
      tx,
    );
    return row;
  });
}

export interface DeleteSystemAccountInput {
  tenant_id: string;
  id: string;
  actor_kind?: PrincipalKind;
  actor_id: string | null;
}

export async function deleteSystemAccount(input: DeleteSystemAccountInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(systemAccounts)
      .set({ deleted_at: new Date(now()) })
      .where(
        and(
          eq(systemAccounts.tenant_id, input.tenant_id),
          eq(systemAccounts.id, input.id),
          isNull(systemAccounts.deleted_at),
        ),
      )
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
        action: AuditAction.SYSTEM_ACCOUNT_DELETED,
        resource_type: "system_account",
        resource_id: row.id,
        result: "success",
        metadata: { name: row.name },
      },
      tx,
    );
    return row;
  });
}

export interface ApiKeyView {
  id: string;
  tenant_id: string;
  prefix: string;
  name: string | null;
  scopes: string[];
  user_id: string | null;
  system_account_id: string | null;
  creator: ApiKeyCreator | null;
  allowed_workflows: string[] | null;
  allowed_connectors: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  rotating_out_at: Date | null;
  rotated_from_id: string | null;
  revoked_at: Date | null;
}

export type ApiKeyCreator =
  | { kind: "user"; id: string }
  | { kind: "system_account"; id: string }
  | { kind: "system"; id: null };

function resolveApiKeyCreator(
  actor: ApiKeyCreator | null | undefined,
  actorId: string | null | undefined,
): ApiKeyCreator | null {
  if (actor === undefined) return null;
  const expectedActorId = actor && actor.kind !== "system" ? actor.id : null;
  if (actorId !== undefined && actorId !== expectedActorId) {
    throw new Error("api_key_actor_provenance_mismatch");
  }
  return actor;
}

function apiKeyActorId(actor: ApiKeyCreator | null | undefined): string | null {
  return actor && actor.kind !== "system" ? actor.id : null;
}

function toApiKeyView(row: typeof apiKeys.$inferSelect): ApiKeyView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    prefix: row.prefix,
    name: row.name ?? null,
    scopes: row.scopes,
    user_id: row.user_id ?? null,
    system_account_id: row.system_account_id ?? null,
    creator:
      row.creator_kind === "user" && row.creator_id
        ? { kind: "user", id: row.creator_id }
        : row.creator_kind === "system_account" && row.creator_id
          ? { kind: "system_account", id: row.creator_id }
          : row.creator_kind === "system" && row.creator_id === null
            ? { kind: "system", id: null }
            : null,
    allowed_workflows: row.allowed_workflows ?? null,
    allowed_connectors: row.allowed_connectors ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    rotating_out_at: row.rotating_out_at ?? null,
    rotated_from_id: row.rotated_from_id ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

export async function listApiKeys(tenantId: string, exec?: Executor): Promise<ApiKeyView[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenant_id, tenantId))
    .orderBy(desc(apiKeys.created_at));
  return rows.map(toApiKeyView);
}

export async function getApiKey(
  tenantId: string,
  id: string,
  exec?: Executor,
): Promise<ApiKeyView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenant_id, tenantId), eq(apiKeys.id, id)))
    .limit(1);
  return rows[0] ? toApiKeyView(rows[0]) : null;
}

export interface IssueApiKeyInput {
  tenant_id: string;
  owner_kind: "user" | "system_account";
  owner_id: string;
  name?: string;
  scopes?: string[];
  allowed_workflows?: string[];
  allowed_connectors?: string[];
  expires_at?: Date;
  actor?: ApiKeyCreator | null;
  actor_id?: string | null;
  rotated_from_id?: string;
}

export interface IssueApiKeyResult {
  view: ApiKeyView;
  plaintext: string;
}

export async function issueApiKey(
  input: IssueApiKeyInput,
  exec?: Executor,
): Promise<IssueApiKeyResult> {
  const db = exec ?? getDb();
  const actor = resolveApiKeyCreator(input.actor, input.actor_id);
  const actorId = apiKeyActorId(input.actor);
  const key = generateKey();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.owner_kind === "user" ? input.owner_id : null,
        system_account_id: input.owner_kind === "system_account" ? input.owner_id : null,
        creator_kind: actor?.kind ?? null,
        creator_id: actor?.kind === "system" ? null : (actor?.id ?? null),
        prefix: key.prefix,
        token_sha256: key.hash,
        name: input.name ?? null,
        scopes: input.scopes ?? ["*"],
        allowed_workflows: input.allowed_workflows ?? null,
        allowed_connectors: input.allowed_connectors ?? null,
        expires_at: input.expires_at ?? null,
        rotated_from_id: input.rotated_from_id ?? null,
      })
      .returning();
    assertInsertRow(row, "api_keys");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: actor?.kind ?? "unknown",
        actor_id: actor ? actorId : null,
        action: AuditAction.API_KEY_ISSUED,
        resource_type: "api_key",
        resource_id: row.id,
        result: "success",
        metadata: {
          owner_kind: input.owner_kind,
          owner_id: input.owner_id,
          prefix: row.prefix,
          rotated_from_id: input.rotated_from_id ?? null,
        },
      },
      tx,
    );
    log.identity.apiKey.issued({
      api_key_id: row.id,
      tenant_id: input.tenant_id,
      prefix: row.prefix,
      owner_kind: input.owner_kind,
      has_expiry: row.expires_at !== null,
      rotated_from_id: input.rotated_from_id ?? null,
      actor_id: actorId,
    });
    return { view: toApiKeyView(row), plaintext: key.plaintext };
  });
}

export interface RotateApiKeyInput {
  tenant_id: string;
  id: string;
  overlap_minutes?: number;
  actor?: ApiKeyCreator | null;
  actor_id?: string | null;
}

export interface RotateApiKeyResult {
  old: ApiKeyView;
  new: ApiKeyView;
  plaintext: string;
}

export async function rotateApiKey(
  input: RotateApiKeyInput,
  exec?: Executor,
): Promise<RotateApiKeyResult | null> {
  const db = exec ?? getDb();
  const actor = resolveApiKeyCreator(input.actor, input.actor_id);
  const actorId = apiKeyActorId(input.actor);
  const overlapMs = (input.overlap_minutes ?? 60) * 60_000;
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, input.tenant_id), eq(apiKeys.id, input.id)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return null;

    const key = generateKey();
    const [created] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: existing.tenant_id,
        user_id: existing.user_id ?? null,
        system_account_id: existing.system_account_id ?? null,
        creator_kind: actor?.kind ?? null,
        creator_id: actor?.kind === "system" ? null : (actor?.id ?? null),
        prefix: key.prefix,
        token_sha256: key.hash,
        name: existing.name ?? null,
        scopes: existing.scopes,
        allowed_workflows: existing.allowed_workflows ?? null,
        allowed_connectors: existing.allowed_connectors ?? null,
        expires_at: existing.expires_at ?? null,
        rotated_from_id: existing.id,
      })
      .returning();
    assertInsertRow(created, "api_keys");

    const overlapDeadline = new Date(now() + overlapMs);
    const [rotatedOut] = await tx
      .update(apiKeys)
      .set({ rotating_out_at: overlapDeadline })
      .where(eq(apiKeys.id, existing.id))
      .returning();
    if (!rotatedOut) throw new Error("api_keys rotate update returned no row");

    await auditAwait(
      {
        tenant_id: existing.tenant_id,
        actor_type: actor?.kind ?? "unknown",
        actor_id: actor ? actorId : null,
        action: AuditAction.API_KEY_ISSUED,
        resource_type: "api_key",
        resource_id: created.id,
        result: "success",
        metadata: {
          owner_kind: existing.user_id ? "user" : "system_account",
          owner_id: existing.user_id ?? existing.system_account_id,
          prefix: created.prefix,
          rotated_from_id: existing.id,
        },
      },
      tx,
    );
    await auditAwait(
      {
        tenant_id: existing.tenant_id,
        actor_type: actor?.kind ?? "unknown",
        actor_id: actor ? actorId : null,
        action: AuditAction.API_KEY_ROTATED,
        resource_type: "api_key",
        resource_id: existing.id,
        result: "success",
        metadata: {
          rotated_to_id: created.id,
          overlap_minutes: input.overlap_minutes ?? 60,
          rotating_out_at: overlapDeadline.toISOString(),
        },
      },
      tx,
    );

    log.identity.apiKey.rotated({
      rotated_from_id: existing.id,
      rotated_to_id: created.id,
      tenant_id: existing.tenant_id,
      old_prefix: existing.prefix,
      new_prefix: created.prefix,
      overlap_minutes: input.overlap_minutes ?? 60,
      actor_id: actorId,
    });

    return {
      old: toApiKeyView(rotatedOut),
      new: toApiKeyView(created),
      plaintext: key.plaintext,
    };
  });
}

export interface RevokeApiKeyInput {
  tenant_id: string;
  id: string;
  actor_id: string | null;
  actor_kind?: AuditActorType;
}

export async function revokeApiKey(
  input: RevokeApiKeyInput,
  exec?: Executor,
): Promise<ApiKeyView | null> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revoked_at: new Date(now()) })
      .where(
        and(
          eq(apiKeys.tenant_id, input.tenant_id),
          eq(apiKeys.id, input.id),
          isNull(apiKeys.revoked_at),
        ),
      )
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
        action: AuditAction.API_KEY_REVOKED,
        resource_type: "api_key",
        resource_id: row.id,
        result: "success",
        metadata: { prefix: row.prefix },
      },
      tx,
    );
    log.identity.apiKey.revoked({
      api_key_id: row.id,
      tenant_id: input.tenant_id,
      prefix: row.prefix,
      actor_id: input.actor_id,
    });
    return toApiKeyView(row);
  });
}

export interface PortalTokenView {
  id: string;
  tenant_id: string;
  enduser_ref: string;
  prefix: string;
  allowed_workflows: string[];
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function toPortalTokenView(row: typeof portalTokens.$inferSelect): PortalTokenView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    enduser_ref: row.enduser_ref,
    prefix: row.prefix,
    allowed_workflows: row.allowed_workflows,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  };
}

export async function listPortalTokens(tenantId: string, exec?: Executor) {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(portalTokens)
    .where(eq(portalTokens.tenant_id, tenantId))
    .orderBy(desc(portalTokens.created_at));
  return rows.map(toPortalTokenView);
}

export interface IssuePortalTokenInput {
  tenant_id: string;
  user_id: string;
  allowed_workflows: string[];
  ttl_minutes?: number;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

export interface IssuePortalTokenResult {
  view: PortalTokenView;
  plaintext: string;
}

export async function issuePortalToken(
  input: IssuePortalTokenInput,
  exec?: Executor,
): Promise<IssuePortalTokenResult> {
  const db = exec ?? getDb();
  const ttlMs = (input.ttl_minutes ?? 24 * 60) * 60_000;
  return db.transaction(async (tx) => {
    const key = generatePortalToken();
    const [row] = await tx
      .insert(portalTokens)
      .values({
        tenant_id: input.tenant_id,
        enduser_ref: input.user_id,
        prefix: key.prefix,
        token_sha256: key.hash,
        allowed_workflows: input.allowed_workflows,
        expires_at: new Date(now() + ttlMs),
      })
      .returning();
    assertInsertRow(row, "portal_tokens");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
        action: AuditAction.PORTAL_TOKEN_ISSUED,
        resource_type: "portal_token",
        resource_id: row.id,
        result: "success",
        metadata: {
          enduser_ref: input.user_id,
          allowed_workflows: input.allowed_workflows,
        },
      },
      tx,
    );
    log.identity.portalToken.issued({
      portal_token_id: row.id,
      tenant_id: input.tenant_id,
      enduser_ref: input.user_id,
      workflow_count: input.allowed_workflows.length,
      ttl_ms: ttlMs,
      actor_id: input.actor_id,
    });
    return { view: toPortalTokenView(row), plaintext: key.plaintext };
  });
}

export interface RevokePortalTokenInput {
  tenant_id: string;
  id: string;
  actor_id: string | null;
  actor_kind?: AuditActorType;
}

export async function revokePortalToken(input: RevokePortalTokenInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(portalTokens)
      .set({ revoked_at: new Date(now()) })
      .where(
        and(
          eq(portalTokens.tenant_id, input.tenant_id),
          eq(portalTokens.id, input.id),
          isNull(portalTokens.revoked_at),
        ),
      )
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({ actor_type: input.actor_kind, actor_id: input.actor_id }),
        action: AuditAction.PORTAL_TOKEN_REVOKED,
        resource_type: "portal_token",
        resource_id: row.id,
        result: "success",
        metadata: { prefix: row.prefix },
      },
      tx,
    );
    log.identity.portalToken.revoked({
      portal_token_id: row.id,
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
    });
    return toPortalTokenView(row);
  });
}

export { hashKey };

export interface SessionView {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

function toSessionView(row: typeof sessions.$inferSelect): SessionView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at ?? row.created_at,
    absolute_expires_at:
      row.absolute_expires_at ?? new Date(row.created_at.getTime() + SESSION_ABSOLUTE_TTL_MS),
    revoked_at: row.revoked_at ?? null,
    created_at: row.created_at,
  };
}

export interface CreateSessionInput {
  tenant_id: string;
  user_id: string;
  actor_id?: string | null;
}

export async function createSession(
  input: CreateSessionInput,
  exec?: Executor,
): Promise<SessionView> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const issuedAt = new Date(now());
    const absolute = new Date(issuedAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
    const [row] = await tx
      .insert(sessions)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        expires_at: absolute,
        last_seen_at: issuedAt,
        absolute_expires_at: absolute,
      })
      .returning();
    assertInsertRow(row, "sessions");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "user",
        actor_id: input.actor_id ?? input.user_id,
        action: AuditAction.SESSION_ISSUED,
        resource_type: "session",
        resource_id: row.id,
        result: "success",
        metadata: {
          sliding_ttl_ms: SESSION_SLIDING_TTL_MS,
          absolute_ttl_ms: SESSION_ABSOLUTE_TTL_MS,
        },
      },
      tx,
    );
    return toSessionView(row);
  });
}

export type ResolveSessionReason = "expired_sliding" | "expired_absolute" | "revoked" | "not_found";

export interface ResolveSessionResult {
  session: SessionView | null;
  reason?: ResolveSessionReason;
}

export async function resolveSession(
  sessionId: string,
  exec?: Executor,
): Promise<ResolveSessionResult> {
  const db = exec ?? getDb();
  // tenant-filter:exempt — pre-tenant session resolution; tenant_id is read out of the resolved row to *establish* tenant context for downstream code
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) return { session: null, reason: "not_found" };
  if (row.revoked_at) return { session: null, reason: "revoked" };

  const resolvedAt = new Date(now());
  const absolute =
    row.absolute_expires_at ?? new Date(row.created_at.getTime() + SESSION_ABSOLUTE_TTL_MS);
  if (absolute.getTime() <= resolvedAt.getTime()) {
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SESSION_REVOKED,
        resource_type: "session",
        resource_id: row.id,
        result: "denied",
        reason: "expired_absolute",
        metadata: { absolute_expires_at: absolute.toISOString() },
      },
      db,
    );
    return { session: null, reason: "expired_absolute" };
  }

  const lastSeen = row.last_seen_at ?? row.created_at;
  if (resolvedAt.getTime() - lastSeen.getTime() > SESSION_SLIDING_TTL_MS) {
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SESSION_REVOKED,
        resource_type: "session",
        resource_id: row.id,
        result: "denied",
        reason: "expired_sliding",
        metadata: {
          last_seen_at: lastSeen.toISOString(),
          sliding_ttl_ms: SESSION_SLIDING_TTL_MS,
        },
      },
      db,
    );
    return { session: null, reason: "expired_sliding" };
  }

  const [bumped] = await db
    .update(sessions)
    .set({ last_seen_at: resolvedAt })
    .where(eq(sessions.id, row.id))
    .returning();
  return { session: toSessionView(bumped ?? { ...row, last_seen_at: resolvedAt }) };
}
