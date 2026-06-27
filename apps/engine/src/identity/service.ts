// Identity domain service. CRUD for tenants, users, system_accounts,
// api_keys, portal_tokens. Every mutation writes a corresponding audit_log
// row inside the same transaction so partial failures cannot orphan an
// audit entry.

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  apiKeys,
  portalTokens,
  sessions,
  systemAccounts,
  tenants,
  userInvites,
  users,
} from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { now } from "../utils/clock.ts";
import { generateKey, hashKey } from "./api-key.ts";
import { generatePortalToken } from "./portal-token.ts";

// GC6 — session TTL defaults. Sliding 8h / absolute 30d per
// docs/operations.md.
export const SESSION_SLIDING_TTL_MS = 8 * 60 * 60 * 1000; // 8 h
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 d

export interface ListOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

// ---------- tenants ---------------------------------------------------------

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

// ---------- users -----------------------------------------------------------

export async function listUsers(tenantId: string, opts: ListOptions = {}, exec?: Executor) {
  const db = exec ?? getDb();
  return db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)))
    .orderBy(desc(users.created_at))
    .limit(clampLimit(opts.limit))
    .offset(opts.offset ?? 0);
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
  role_id?: string | null;
  actor_id: string | null;
}

/**
 * Update a user's role (legacy enum + optional `role_id`). Writes a
 * `USER_ROLE_CHANGED` audit row carrying the before/after role. Returns
 * `null` when no matching non-deleted user exists in the tenant.
 */
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

    const patch: { role?: UserRole; role_id?: string | null; updated_at: Date } = {
      updated_at: new Date(now()),
    };
    if (input.role !== undefined) patch.role = input.role;
    if (input.role_id !== undefined) patch.role_id = input.role_id;

    const [row] = await tx
      .update(users)
      .set(patch)
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.id)))
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.USER_ROLE_CHANGED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        before: { role: before.role, role_id: before.role_id },
        after: { role: row.role, role_id: row.role_id },
        metadata: { email: row.email },
      },
      tx,
    );
    return row;
  });
}

// ---------- system accounts -------------------------------------------------

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
        actor_type: "user",
        actor_id: input.actor_id,
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
        actor_type: "user",
        actor_id: input.actor_id,
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

// ---------- api keys --------------------------------------------------------

export interface ApiKeyView {
  id: string;
  tenant_id: string;
  prefix: string;
  scopes: string[];
  user_id: string | null;
  system_account_id: string | null;
  allowed_workflows: string[] | null;
  allowed_connectors: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  rotating_out_at: Date | null;
  rotated_from_id: string | null;
  revoked_at: Date | null;
}

function toApiKeyView(row: typeof apiKeys.$inferSelect): ApiKeyView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    prefix: row.prefix,
    scopes: row.scopes,
    user_id: row.user_id ?? null,
    system_account_id: row.system_account_id ?? null,
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
  scopes?: string[];
  allowed_workflows?: string[];
  allowed_connectors?: string[];
  expires_at?: Date;
  actor_id: string | null;
  // When set, the new key carries a rotated_from_id pointing at the old key.
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
  const key = generateKey();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.owner_kind === "user" ? input.owner_id : null,
        system_account_id: input.owner_kind === "system_account" ? input.owner_id : null,
        prefix: key.prefix,
        token_sha256: key.hash,
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
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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
      actor_id: input.actor_id,
    });
    return { view: toApiKeyView(row), plaintext: key.plaintext };
  });
}

export interface RotateApiKeyInput {
  tenant_id: string;
  id: string;
  overlap_minutes?: number;
  actor_id: string | null;
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
  const overlapMs = (input.overlap_minutes ?? 60) * 60_000;
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenant_id, input.tenant_id), eq(apiKeys.id, input.id)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return null;

    // Issue replacement key inheriting owner + scopes + allow lists.
    const key = generateKey();
    const [created] = await tx
      .insert(apiKeys)
      .values({
        tenant_id: existing.tenant_id,
        user_id: existing.user_id ?? null,
        system_account_id: existing.system_account_id ?? null,
        prefix: key.prefix,
        token_sha256: key.hash,
        scopes: existing.scopes,
        allowed_workflows: existing.allowed_workflows ?? null,
        allowed_connectors: existing.allowed_connectors ?? null,
        expires_at: existing.expires_at ?? null,
        rotated_from_id: existing.id,
      })
      .returning();
    assertInsertRow(created, "api_keys");

    // Schedule the old key to be phased out at now + overlap. We use the
    // dedicated `rotating_out_at` column so the original `expires_at`
    // (caller-supplied lifetime) is preserved untouched. The api_key
    // provider treats `rotating_out_at <= now()` as a soft revoke.
    const overlapDeadline = new Date(now() + overlapMs);
    const [rotatedOut] = await tx
      .update(apiKeys)
      .set({ rotating_out_at: overlapDeadline })
      .where(eq(apiKeys.id, existing.id))
      .returning();
    if (!rotatedOut) throw new Error("api_keys rotate update returned no row");

    // Audit the new key as `api_key.issued` so the chain of issued events
    // remains complete, then the `api_key.rotated` event on the old key.
    await auditAwait(
      {
        tenant_id: existing.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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
      actor_id: input.actor_id,
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
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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

// ---------- portal tokens ---------------------------------------------------

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
  user_id: string; // used as enduser_ref in P2
  allowed_workflows: string[];
  ttl_minutes?: number;
  actor_id: string | null;
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
  // Default portal-token TTL — 24 h per docs/security-governance.md.
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
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
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

// Re-export hashKey for callers that need to seed test rows.
export { hashKey };

// ---------- sessions -------------------------------------------------------

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

/**
 * Create a fresh session row with sliding + absolute TTL columns set:
 *   - `last_seen_at` = now (the 8 h sliding window starts here)
 *   - `absolute_expires_at` = created_at + 30 d (hard ceiling)
 *   - `expires_at` mirrors `absolute_expires_at` so legacy callers that
 *     only look at `expires_at` still reject well-past-lifetime sessions.
 *
 * Every call writes a `session.issued` audit row.
 */
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

/**
 * Resolve a session by id and enforce the sliding + absolute TTLs.
 *
 * Rejection paths write a `session.revoked` audit row with a typed
 * `reason` so operators can distinguish between "user sat idle" and
 * "session hit its 30 d ceiling." On success the row's `last_seen_at`
 * is bumped to `now` so the sliding window restarts.
 */
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

  // Bump sliding window on successful resolve. Best-effort: the session
  // is valid for *this* request regardless of whether the update lands.
  const [bumped] = await db
    .update(sessions)
    .set({ last_seen_at: resolvedAt })
    .where(eq(sessions.id, row.id))
    .returning();
  return { session: toSessionView(bumped ?? { ...row, last_seen_at: resolvedAt }) };
}
