// Identity provisioning: user create/deactivate + the single-use invite
// lifecycle (create / list / revoke / redeem). Split out of `service.ts`
// to keep both files under the 1000-LOC ceiling.
//
// Import direction is ONE-WAY: this module depends on `service.ts`
// (issueApiKey + its result/type aliases); `service.ts` never imports back.
// Every mutation writes its audit row inside the same transaction so a
// partial failure cannot orphan an audit entry.

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { apiKeys, userInvites, users } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { now } from "../utils/clock.ts";
import { constantTimeHexEquals } from "./api-key.ts";
import { generateInviteToken, parseInviteToken } from "./invite.ts";
import { type IssueApiKeyResult, issueApiKey, type UserRole, type UserStatus } from "./service.ts";

// ---------- users -----------------------------------------------------------

/** Thrown by `createUser` when a non-deleted user already exists for the
 *  `(tenant_id, email)` pair. The route layer maps this to a 409. Kept as
 *  a domain-layer error so the service never reaches into `http/errors`. */
export class DuplicateUserError extends Error {
  readonly code = "duplicate_user" as const;
  constructor(email: string) {
    super(`user already exists for this tenant: ${email}`);
    this.name = "DuplicateUserError";
  }
}

export interface CreateUserInput {
  tenant_id: string;
  email: string;
  role?: UserRole;
  role_id?: string | null;
  status?: UserStatus;
  actor_id: string | null;
}

/**
 * Create a user row in the caller's tenant. Rejects a duplicate
 * `(tenant_id, email)` among non-deleted users with `DuplicateUserError`.
 * Writes a `USER_CREATED` audit row inside the same transaction. The
 * `role` enum defaults to `member`; the legacy enum is the source the RBAC
 * evaluator falls back to when `role_id` is unset.
 */
export async function createUser(input: CreateUserInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, input.tenant_id),
          eq(users.email, input.email),
          isNull(users.deleted_at),
        ),
      )
      .limit(1);
    if (existing.length > 0) throw new DuplicateUserError(input.email);

    const [row] = await tx
      .insert(users)
      .values({
        tenant_id: input.tenant_id,
        email: input.email,
        role: input.role ?? "member",
        role_id: input.role_id ?? null,
        status: input.status ?? "active",
      })
      .returning();
    assertInsertRow(row, "users");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.USER_CREATED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        metadata: { email: row.email, role: row.role, status: row.status },
      },
      tx,
    );
    return row;
  });
}

export interface DeactivateUserInput {
  tenant_id: string;
  user_id: string;
  actor_id: string | null;
}

/**
 * Soft-deactivate a user: set `deleted_at` + `status='disabled'`, revoke
 * every one of the user's non-revoked api keys, AND revoke every one of the
 * user's still-pending (un-redeemed, un-revoked) invites — all in the SAME
 * transaction. The api-key provider does not check `users.deleted_at`, so
 * revoking the keys is what severs existing access; revoking the pending
 * invites closes the resurrection path where a deactivated user redeems a
 * still-live invite to mint a fresh key (the redeem claim's
 * `isNull(revoked_at)` guard then fails). Writes one `USER_DELETED` audit row,
 * an `API_KEY_REVOKED` row per key, and an `INVITE_REVOKED` row per invite.
 * Returns `null` if the user is already gone.
 */
export async function deactivateUser(input: DeactivateUserInput, exec?: Executor) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const nowTs = new Date(now());
    const [row] = await tx
      .update(users)
      .set({ deleted_at: nowTs, status: "disabled", updated_at: nowTs })
      .where(
        and(
          eq(users.tenant_id, input.tenant_id),
          eq(users.id, input.user_id),
          isNull(users.deleted_at),
        ),
      )
      .returning();
    if (!row) return null;

    const revoked = await tx
      .update(apiKeys)
      .set({ revoked_at: nowTs })
      .where(
        and(
          eq(apiKeys.tenant_id, input.tenant_id),
          eq(apiKeys.user_id, input.user_id),
          isNull(apiKeys.revoked_at),
        ),
      )
      .returning();

    for (const key of revoked) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_id ? "user" : "system",
          actor_id: input.actor_id,
          action: AuditAction.API_KEY_REVOKED,
          resource_type: "api_key",
          resource_id: key.id,
          result: "success",
          metadata: { prefix: key.prefix, reason: "user_deactivated" },
        },
        tx,
      );
    }

    // Sever still-pending invites so a deactivated user can't redeem one to
    // mint a fresh key. Same tx → a concurrent redeem either loses the claim
    // (this revoke commits first) or mints a key that the api-key revoke above
    // catches; either ordering leaves the user with no live credential.
    const revokedInvites = await tx
      .update(userInvites)
      .set({ revoked_at: nowTs, updated_at: nowTs })
      .where(
        and(
          eq(userInvites.tenant_id, input.tenant_id),
          eq(userInvites.user_id, input.user_id),
          isNull(userInvites.redeemed_at),
          isNull(userInvites.revoked_at),
        ),
      )
      .returning();

    for (const inv of revokedInvites) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_id ? "user" : "system",
          actor_id: input.actor_id,
          action: AuditAction.INVITE_REVOKED,
          resource_type: "user_invite",
          resource_id: inv.id,
          result: "success",
          metadata: { invite_id: inv.id, user_id: inv.user_id, prefix: inv.prefix },
        },
        tx,
      );
    }

    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.USER_DELETED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        metadata: {
          email: row.email,
          revoked_api_keys: revoked.length,
          revoked_invites: revokedInvites.length,
        },
      },
      tx,
    );
    return row;
  });
}

// ---------- user invites ----------------------------------------------------

// Default invite TTL — 7 days. Long enough for an onboarding email to be
// actioned, short enough that a stale invite stops being redeemable.
export const INVITE_DEFAULT_TTL_MINUTES = 7 * 24 * 60; // 10080

export interface InviteView {
  id: string;
  tenant_id: string;
  user_id: string;
  prefix: string;
  scopes: string[];
  allowed_workflows: string[] | null;
  allowed_connectors: string[] | null;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

function toInviteView(row: typeof userInvites.$inferSelect): InviteView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    prefix: row.prefix,
    scopes: row.scopes,
    allowed_workflows: row.allowed_workflows ?? null,
    allowed_connectors: row.allowed_connectors ?? null,
    expires_at: row.expires_at,
    redeemed_at: row.redeemed_at ?? null,
    revoked_at: row.revoked_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export interface CreateInviteInput {
  tenant_id: string;
  user_id: string;
  scopes?: string[];
  allowed_workflows?: string[];
  allowed_connectors?: string[];
  ttl_minutes?: number;
  actor_id: string | null;
}

export interface CreateInviteResult {
  view: InviteView;
  plaintext: string;
}

/**
 * Mint a single-use invite for an existing user in the tenant. The scopes
 * recorded here are EXACTLY what the redeemed personal api key will carry —
 * redemption never widens them. The returned `plaintext` is shown to the
 * admin once so they can hand it to the invited user; the engine stores
 * only the sha256. Writes a `USER_INVITED` audit row.
 */
export async function createInvite(
  input: CreateInviteInput,
  exec?: Executor,
): Promise<CreateInviteResult> {
  const db = exec ?? getDb();
  const ttlMs = (input.ttl_minutes ?? INVITE_DEFAULT_TTL_MINUTES) * 60_000;
  return db.transaction(async (tx) => {
    const token = generateInviteToken();
    const expiresAt = new Date(now() + ttlMs);
    const [row] = await tx
      .insert(userInvites)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        prefix: token.prefix,
        token_sha256: token.hash,
        scopes: input.scopes ?? ["*"],
        allowed_workflows: input.allowed_workflows ?? null,
        allowed_connectors: input.allowed_connectors ?? null,
        expires_at: expiresAt,
        created_by: input.actor_id,
      })
      .returning();
    assertInsertRow(row, "user_invites");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.USER_INVITED,
        resource_type: "user_invite",
        resource_id: row.id,
        result: "success",
        metadata: {
          invite_id: row.id,
          user_id: row.user_id,
          prefix: row.prefix,
          scopes: row.scopes,
          allowed_workflows: row.allowed_workflows ?? null,
          allowed_connectors: row.allowed_connectors ?? null,
          expires_at: expiresAt.toISOString(),
        },
      },
      tx,
    );
    logger.info({
      module: "identity",
      action: "invite.created",
      msg: "user invite minted",
      invite_id: row.id,
      tenant_id: input.tenant_id,
      user_id: row.user_id,
      prefix: row.prefix,
      ttl_ms: ttlMs,
      actor_id: input.actor_id,
    });
    return { view: toInviteView(row), plaintext: token.plaintext };
  });
}

export interface ListInvitesOptions {
  status?: "pending" | "redeemed" | "revoked" | "expired";
}

/**
 * List invites for a tenant, newest first. The optional `status` filter is
 * derived at read time from the timestamp columns (no denormalised status
 * column on the row).
 */
export async function listInvites(
  tenantId: string,
  opts: ListInvitesOptions = {},
  exec?: Executor,
): Promise<InviteView[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(userInvites)
    .where(eq(userInvites.tenant_id, tenantId))
    .orderBy(desc(userInvites.created_at));
  const views = rows.map(toInviteView);
  if (!opts.status) return views;
  const nowTs = now();
  return views.filter((v) => {
    if (v.revoked_at) return opts.status === "revoked";
    if (v.redeemed_at) return opts.status === "redeemed";
    if (v.expires_at.getTime() <= nowTs) return opts.status === "expired";
    return opts.status === "pending";
  });
}

export interface RevokeInviteInput {
  tenant_id: string;
  invite_id: string;
  actor_id: string | null;
}

/**
 * Revoke an un-redeemed, un-revoked invite. Returns `null` when no such
 * invite exists in the tenant. Writes an `INVITE_REVOKED` audit row inside
 * the same transaction as the stamp — `enforce()` only audits on deny, so
 * without this the successful revoke would be invisible in the audit trail.
 */
export async function revokeInvite(
  input: RevokeInviteInput,
  exec?: Executor,
): Promise<InviteView | null> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(userInvites)
      .set({ revoked_at: new Date(now()) })
      .where(
        and(
          eq(userInvites.tenant_id, input.tenant_id),
          eq(userInvites.id, input.invite_id),
          isNull(userInvites.revoked_at),
          isNull(userInvites.redeemed_at),
        ),
      )
      .returning();
    if (!row) return null;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.INVITE_REVOKED,
        resource_type: "user_invite",
        resource_id: row.id,
        result: "success",
        metadata: { invite_id: row.id, user_id: row.user_id, prefix: row.prefix },
      },
      tx,
    );
    return toInviteView(row);
  });
}

export type RedeemInviteError =
  | "invite_invalid"
  | "invite_expired"
  | "invite_revoked"
  | "invite_already_redeemed";

export type RedeemInviteOutcome =
  | {
      ok: true;
      invite_id: string;
      user_id: string;
      tenant_id: string;
      api_key: IssueApiKeyResult;
    }
  | { ok: false; code: RedeemInviteError };

export interface RedeemInviteInput {
  token: string;
}

/**
 * Redeem a single-use invite. UNAUTHENTICATED entry point — the caller has
 * no principal yet; the invite token IS the proof. In one transaction:
 * mint a personal api key for the invite's user carrying exactly the
 * invite's scopes + allow lists, stamp `redeemed_at`, and flip the user to
 * `status='active'`. The api key plaintext is returned ONCE and is never
 * visible to the admin who issued the invite.
 *
 * The lookup is by indexed prefix, then a constant-time sha256 compare, so
 * a wrong-but-well-formed token can't act as a timing oracle. Expiry /
 * revocation / prior-redemption all map to distinct typed error codes.
 */
export async function redeemInvite(
  input: RedeemInviteInput,
  exec?: Executor,
): Promise<RedeemInviteOutcome> {
  const db = exec ?? getDb();
  const parsed = parseInviteToken(input.token);
  if (!parsed) return { ok: false, code: "invite_invalid" };

  // Pre-read by indexed prefix + constant-time sha256 compare. Pre-tenant:
  // the tenant_id is read out of the resolved invite row to scope every
  // subsequent write. These three states (invalid / revoked / expired) are
  // stable — they cannot be reached by a concurrent redeem, so deciding
  // them here (before the claim) keeps the typed error codes precise.
  // tenant-filter:exempt — prefix-based credential lookup pre-tenant.
  const rows = await db
    .select()
    .from(userInvites)
    .where(eq(userInvites.prefix, parsed.prefix))
    .limit(1);
  const invite = rows[0];
  if (!invite) return { ok: false, code: "invite_invalid" };
  if (!constantTimeHexEquals(invite.token_sha256, parsed.hash)) {
    return { ok: false, code: "invite_invalid" };
  }
  if (invite.revoked_at) return { ok: false, code: "invite_revoked" };
  if (invite.redeemed_at) return { ok: false, code: "invite_already_redeemed" };
  if (invite.expires_at.getTime() <= now()) return { ok: false, code: "invite_expired" };

  // Defense-in-depth: refuse to resurrect a deactivated user. deactivateUser
  // revokes pending invites in-tx (so the concurrent path fails the claim
  // below), but a non-concurrent invite-for-an-already-deleted-user must also
  // be rejected. Surface the generic invalid code — never reveal user state to
  // an unauthenticated redeemer.
  const userRows = await db
    .select({ deleted_at: users.deleted_at })
    .from(users)
    .where(and(eq(users.tenant_id, invite.tenant_id), eq(users.id, invite.user_id)))
    .limit(1);
  if (!userRows[0] || userRows[0].deleted_at) return { ok: false, code: "invite_invalid" };

  return db.transaction(async (tx) => {
    const redeemedAt = new Date(now());

    // Claim-first: this conditional UPDATE is the serialization point. Two
    // concurrent redeems both reach here; the row lock the UPDATE takes
    // serializes them, and the `isNull(redeemed_at)` guard means the loser
    // updates 0 rows. It returns `invite_already_redeemed` and NEVER mints a
    // key — issueApiKey runs only after a successful claim below.
    const [claimed] = await tx
      .update(userInvites)
      .set({ redeemed_at: redeemedAt, updated_at: redeemedAt })
      .where(
        and(
          eq(userInvites.id, invite.id),
          isNull(userInvites.redeemed_at),
          isNull(userInvites.revoked_at),
        ),
      )
      .returning();
    if (!claimed) return { ok: false, code: "invite_already_redeemed" };

    // Mint the user's OWN api key inside this tx. actor_id is null —
    // there is no authenticated principal; the api key is attributed to a
    // system actor in the audit trail, owned by the invited user.
    const apiKey = await issueApiKey(
      {
        tenant_id: claimed.tenant_id,
        owner_kind: "user",
        owner_id: claimed.user_id,
        scopes: claimed.scopes,
        ...(claimed.allowed_workflows ? { allowed_workflows: claimed.allowed_workflows } : {}),
        ...(claimed.allowed_connectors ? { allowed_connectors: claimed.allowed_connectors } : {}),
        actor_id: null,
      },
      tx,
    );

    await tx
      .update(users)
      .set({ status: "active", updated_at: redeemedAt })
      .where(and(eq(users.tenant_id, claimed.tenant_id), eq(users.id, claimed.user_id)));

    await auditAwait(
      {
        tenant_id: claimed.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.INVITE_REDEEMED,
        resource_type: "user_invite",
        resource_id: claimed.id,
        result: "success",
        metadata: {
          invite_id: claimed.id,
          user_id: claimed.user_id,
          api_key_id: apiKey.view.id,
          prefix: claimed.prefix,
        },
      },
      tx,
    );

    return {
      ok: true,
      invite_id: claimed.id,
      user_id: claimed.user_id,
      tenant_id: claimed.tenant_id,
      api_key: apiKey,
    };
  });
}
