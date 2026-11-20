import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import type { PrincipalKind } from "../auth/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  apiKeys,
  chatIdentities,
  groupMembers,
  groups,
  resourceGrants,
  sessions,
  tenants,
  userIdentities,
  userInvites,
  users,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { authorizeRequestedScopes, type ScopeIssuer } from "../rbac/scope-issuance.ts";
import { now } from "../utils/clock.ts";
import { constantTimeHexEquals } from "./api-key.ts";
import { endCockpitPushForSessions } from "./cockpit-push.ts";
import { generateInviteToken, parseInviteToken } from "./invite.ts";
import { assertAdminRemains } from "./last-admin.ts";
import { revokeConnectionsForUser } from "./oauth-connections.ts";
import { assertTenantActive } from "./self-service.ts";
import { type IssueApiKeyResult, issueApiKey, type UserRole, type UserStatus } from "./service.ts";
import { linkJoinedApprover } from "./setup-preferences.ts";

function auditActor(
  actorKind: PrincipalKind | "system" | undefined,
  actorId: string | null,
): {
  actor_type: AuditActorType;
  actor_id: string | null;
} {
  if (!actorKind || (actorKind !== "system" && actorId === null)) {
    return { actor_type: "unknown", actor_id: null };
  }
  return { actor_type: actorKind, actor_id: actorKind === "system" ? null : actorId };
}

export class DuplicateUserError extends Error {
  readonly code = "duplicate_user" as const;
  constructor(email: string) {
    super(`user already exists for this tenant: ${email}`);
    this.name = "DuplicateUserError";
  }
}

interface CreateUserInput {
  tenant_id: string;
  email: string;
  display_name?: string | null;
  role?: UserRole;
  role_id?: string;
  status?: UserStatus;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

async function restoreRemovedUserWithoutFormerAccess(
  tx: Executor,
  removed: typeof users.$inferSelect,
  next: { display_name: string | null; role_id: string; status: UserStatus },
) {
  const owned = { tenant_id: removed.tenant_id, user_id: removed.id };
  await tx
    .delete(userIdentities)
    .where(
      and(eq(userIdentities.tenant_id, owned.tenant_id), eq(userIdentities.user_id, owned.user_id)),
    );
  await tx
    .delete(chatIdentities)
    .where(
      and(eq(chatIdentities.tenant_id, owned.tenant_id), eq(chatIdentities.user_id, owned.user_id)),
    );
  await tx
    .delete(groupMembers)
    .where(
      and(
        eq(groupMembers.user_id, owned.user_id),
        inArray(
          groupMembers.group_id,
          tx.select({ id: groups.id }).from(groups).where(eq(groups.tenant_id, owned.tenant_id)),
        ),
      ),
    );
  await tx
    .delete(resourceGrants)
    .where(
      and(
        eq(resourceGrants.tenant_id, owned.tenant_id),
        eq(resourceGrants.subject_type, "user"),
        eq(resourceGrants.subject_id, owned.user_id),
      ),
    );
  const [row] = await tx
    .update(users)
    .set({
      ...next,
      auth_identity_id: null,
      start_steps_hidden_at: null,
      deleted_at: null,
      updated_at: new Date(now()),
    })
    .where(and(eq(users.tenant_id, owned.tenant_id), eq(users.id, owned.user_id)))
    .returning();
  return row;
}

export async function createUser(input: CreateUserInput, db: Executor) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.email, input.email)))
      .for("update")
      .limit(1);
    if (existing && existing.deleted_at === null) throw new DuplicateUserError(input.email);

    const next = {
      display_name: input.display_name ?? null,
      role_id: input.role_id ?? (await builtinRoleId(tx, input.role ?? "member")),
      status: input.status ?? ("active" as const),
    };
    const row = existing
      ? await restoreRemovedUserWithoutFormerAccess(tx, existing, next)
      : (
          await tx
            .insert(users)
            .values({ tenant_id: input.tenant_id, email: input.email, ...next })
            .onConflictDoNothing({ target: [users.tenant_id, users.email] })
            .returning()
        )[0];
    if (!row) throw new DuplicateUserError(input.email);
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...auditActor(input.actor_kind, input.actor_id),
        action: AuditAction.USER_CREATED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        metadata: {
          email: row.email,
          display_name: row.display_name,
          role_id: row.role_id,
          status: row.status,
          ...(existing ? { restored: true } : {}),
        },
      },
      tx,
    );
    await linkJoinedApprover(tx, { tenant_id: input.tenant_id, id: row.id, email: row.email });
    return row;
  });
}

interface DeactivateUserInput {
  tenant_id: string;
  user_id: string;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

async function neverJoined(tx: Executor, user: typeof users.$inferSelect): Promise<boolean> {
  if (user.status !== "invited" || user.auth_identity_id !== null) return false;
  const [key] = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenant_id, user.tenant_id), eq(apiKeys.user_id, user.id)))
    .limit(1);
  const [session] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tenant_id, user.tenant_id), eq(sessions.user_id, user.id)))
    .limit(1);
  const [identity] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(and(eq(userIdentities.tenant_id, user.tenant_id), eq(userIdentities.user_id, user.id)))
    .limit(1);
  return !key && !session && !identity;
}

async function removeInvitedUser(
  tx: Executor,
  input: DeactivateUserInput,
  user: typeof users.$inferSelect,
) {
  const removedInvites = await tx
    .delete(userInvites)
    .where(and(eq(userInvites.tenant_id, user.tenant_id), eq(userInvites.user_id, user.id)))
    .returning();
  for (const invite of removedInvites) {
    if (invite.revoked_at) continue;
    await auditAwait(
      {
        tenant_id: user.tenant_id,
        ...auditActor(input.actor_kind, input.actor_id),
        action: AuditAction.INVITE_REVOKED,
        resource_type: "user_invite",
        resource_id: invite.id,
        result: "success",
        reason: "invitation_withdrawn",
        metadata: { invite_id: invite.id, user_id: invite.user_id, prefix: invite.prefix },
      },
      tx,
    );
  }
  await tx.delete(users).where(and(eq(users.tenant_id, user.tenant_id), eq(users.id, user.id)));
  await auditAwait(
    {
      tenant_id: user.tenant_id,
      ...auditActor(input.actor_kind, input.actor_id),
      action: AuditAction.USER_DELETED,
      resource_type: "user",
      resource_id: user.id,
      result: "success",
      reason: "invitation_withdrawn",
      metadata: { email: user.email, removed: true, revoked_invites: removedInvites.length },
    },
    tx,
  );
  return user;
}

export async function deactivateUser(input: DeactivateUserInput, db: Executor) {
  const tasks = await import("../tasks/index.ts");
  const effects = tasks.taskEffects();
  const removed = await deactivateUserLocked(input, db, async (tx) => {
    effects.after.length = 0;
    await tasks.pauseTasksOfOwnerLocked(tx, input.tenant_id, input.user_id, effects);
  });
  await tasks.settleTaskEffects(db as Db, effects);
  return removed;
}

async function deactivateUserLocked(
  input: DeactivateUserInput,
  db: Executor,
  pauseOwnedTasks: (tx: Executor) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    const nowTs = new Date(now());
    await assertAdminRemains(tx, {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      nextEffectiveRole: null,
    });
    const [current] = await tx
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenant_id, input.tenant_id),
          eq(users.id, input.user_id),
          isNull(users.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return null;
    await pauseOwnedTasks(tx);
    if (await neverJoined(tx, current)) return removeInvitedUser(tx, input, current);
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
          ...auditActor(input.actor_kind, input.actor_id),
          action: AuditAction.API_KEY_REVOKED,
          resource_type: "api_key",
          resource_id: key.id,
          result: "success",
          metadata: { prefix: key.prefix, reason: "user_deactivated" },
        },
        tx,
      );
    }

    const revokedConnections = await revokeConnectionsForUser(
      tx,
      input.tenant_id,
      input.user_id,
      nowTs,
    );
    if (revokedConnections.access_tokens + revokedConnections.refresh_tokens > 0) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...auditActor(input.actor_kind, input.actor_id),
          action: AuditAction.MCP_OAUTH_TOKEN_REVOKED,
          resource_type: "mcp_oauth_token",
          resource_id: row.id,
          result: "success",
          metadata: {
            reason: "user_deactivated",
            access_tokens_revoked: revokedConnections.access_tokens,
            refresh_tokens_revoked: revokedConnections.refresh_tokens,
            connections_ended: revokedConnections.connections,
          },
        },
        tx,
      );
    }

    const revokedSessions = await tx
      .update(sessions)
      .set({ revoked_at: nowTs })
      .where(
        and(
          eq(sessions.tenant_id, input.tenant_id),
          eq(sessions.user_id, input.user_id),
          isNull(sessions.revoked_at),
        ),
      )
      .returning();
    await endCockpitPushForSessions(
      tx,
      { tenant_id: input.tenant_id, user_id: input.user_id },
      "user_deactivated",
      auditActor(input.actor_kind, input.actor_id),
    );

    for (const session of revokedSessions) {
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...auditActor(input.actor_kind, input.actor_id),
          action: AuditAction.SESSION_REVOKED,
          resource_type: "session",
          resource_id: session.id,
          result: "success",
          metadata: { reason: "user_deactivated" },
        },
        tx,
      );
    }

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
          ...auditActor(input.actor_kind, input.actor_id),
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
        ...auditActor(input.actor_kind, input.actor_id),
        action: AuditAction.USER_DELETED,
        resource_type: "user",
        resource_id: row.id,
        result: "success",
        metadata: {
          email: row.email,
          revoked_api_keys: revoked.length,
          revoked_invites: revokedInvites.length,
          ended_connections: revokedConnections.connections,
        },
      },
      tx,
    );
    return row;
  });
}

const INVITE_DEFAULT_TTL_MINUTES = 7 * 24 * 60;

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

interface CreateInviteInput {
  issuer: ScopeIssuer;
  tenant_id: string;
  user_id: string;
  scopes?: string[];
  allowed_workflows?: string[];
  allowed_connectors?: string[];
  ttl_minutes?: number;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

interface CreateInviteResult {
  view: InviteView;
  plaintext: string;
}

export async function createInvite(
  input: CreateInviteInput,
  db: Executor,
): Promise<CreateInviteResult> {
  const ttlMs = (input.ttl_minutes ?? INVITE_DEFAULT_TTL_MINUTES) * 60_000;
  const scopes = await authorizeRequestedScopes(db, input.issuer, input.scopes);
  return db.transaction(async (tx) => {
    const token = generateInviteToken();
    const expiresAt = new Date(now() + ttlMs);
    const [invitee] = await tx
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.tenant_id, input.tenant_id), eq(users.id, input.user_id)))
      .for("update")
      .limit(1);
    if (invitee?.status === "invited") {
      const replaced = await tx
        .update(userInvites)
        .set({ revoked_at: new Date(now()), updated_at: new Date(now()) })
        .where(
          and(
            eq(userInvites.tenant_id, input.tenant_id),
            eq(userInvites.user_id, input.user_id),
            isNull(userInvites.redeemed_at),
            isNull(userInvites.revoked_at),
          ),
        )
        .returning();
      for (const previous of replaced) {
        await auditAwait(
          {
            tenant_id: input.tenant_id,
            ...auditActor(input.actor_kind, input.actor_id),
            action: AuditAction.INVITE_REVOKED,
            resource_type: "user_invite",
            resource_id: previous.id,
            result: "success",
            reason: "invite_reissued",
            metadata: {
              invite_id: previous.id,
              user_id: previous.user_id,
              prefix: previous.prefix,
            },
          },
          tx,
        );
      }
    }
    const [row] = await tx
      .insert(userInvites)
      .values({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        prefix: token.prefix,
        token_sha256: token.hash,
        scopes,
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
        ...auditActor(input.actor_kind, input.actor_id),
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

export async function createInvitedUser(
  input: Omit<CreateUserInput, "status"> & { issuer: ScopeIssuer; ttl_minutes?: number },
  db: Executor,
) {
  return db.transaction(async (tx) => {
    const { issuer, ttl_minutes, ...user } = input;
    const row = await createUser({ ...user, status: "invited" }, tx);
    const invite = await createInvite(
      {
        issuer,
        tenant_id: input.tenant_id,
        user_id: row.id,
        ...(ttl_minutes !== undefined ? { ttl_minutes } : {}),
        actor_id: input.actor_id,
        ...(input.actor_kind ? { actor_kind: input.actor_kind } : {}),
      },
      tx,
    );
    return { user: row, invite };
  });
}

interface ListInvitesOptions {
  status?: "pending" | "redeemed" | "revoked" | "expired";
}

export async function listInvites(
  tenantId: string,
  opts: ListInvitesOptions = {},
  db: Executor,
): Promise<InviteView[]> {
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

interface RevokeInviteInput {
  tenant_id: string;
  invite_id: string;
  actor_id: string | null;
  actor_kind?: PrincipalKind | "system";
}

export async function revokeInvite(
  input: RevokeInviteInput,
  db: Executor,
): Promise<InviteView | null> {
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
        ...auditActor(input.actor_kind, input.actor_id),
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

type RedeemInviteError =
  | "invite_invalid"
  | "invite_browser_required"
  | "invite_expired"
  | "invite_revoked"
  | "invite_already_redeemed";

type RedeemInviteOutcome =
  | {
      ok: true;
      invite_id: string;
      user_id: string;
      tenant_id: string;
      api_key: IssueApiKeyResult;
    }
  | { ok: false; code: RedeemInviteError };

interface RedeemInviteInput {
  token: string;
}

export async function redeemInvite(
  input: RedeemInviteInput,
  db: Executor,
): Promise<RedeemInviteOutcome> {
  const parsed = parseInviteToken(input.token);
  if (!parsed) return { ok: false, code: "invite_invalid" };

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

  await assertTenantActive(invite.tenant_id, db);
  const [destination] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, invite.tenant_id))
    .limit(1);
  if (destination?.origin === "self_service") return { ok: false, code: "invite_browser_required" };

  const userRows = await db
    .select({ deleted_at: users.deleted_at })
    .from(users)
    .where(and(eq(users.tenant_id, invite.tenant_id), eq(users.id, invite.user_id)))
    .limit(1);
  if (!userRows[0] || userRows[0].deleted_at) return { ok: false, code: "invite_invalid" };

  return db.transaction(async (tx) => {
    const redeemedAt = new Date(now());

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

    const apiKey = await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: claimed.tenant_id,
        owner_kind: "user",
        owner_id: claimed.user_id,
        scopes: claimed.scopes,
        ...(claimed.allowed_workflows ? { allowed_workflows: claimed.allowed_workflows } : {}),
        ...(claimed.allowed_connectors ? { allowed_connectors: claimed.allowed_connectors } : {}),
        actor: { kind: "system", id: null },
      },
      tx,
    );

    const [joined] = await tx
      .update(users)
      .set({ status: "active", updated_at: redeemedAt })
      .where(and(eq(users.tenant_id, claimed.tenant_id), eq(users.id, claimed.user_id)))
      .returning({ id: users.id, email: users.email });
    if (joined)
      await linkJoinedApprover(tx, {
        tenant_id: claimed.tenant_id,
        id: joined.id,
        email: joined.email,
      });

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
