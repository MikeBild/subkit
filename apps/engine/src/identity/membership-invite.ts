import { z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { type Executor, getDb } from "../db/client.ts";
import { authIdentities, tenants, userInvites, users } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { constantTimeHexEquals } from "./api-key.ts";
import { type BrowserMembershipContext, browserMembershipIdentity } from "./browser-memberships.ts";
import { parseInviteToken } from "./invite.ts";
import {
  assertTenantActive,
  getMembershipForIdentity,
  parseVerifiedSelfServiceIdentity,
  type VerifiedSelfServiceIdentity,
} from "./self-service.ts";

export class MembershipInviteError extends Error {
  constructor(
    readonly code:
      | "invite_invalid"
      | "invite_unavailable"
      | "invite_identity_mismatch"
      | "invite_credential_only",
  ) {
    super(code);
    this.name = "MembershipInviteError";
  }
}

export async function claimMembershipInvite(
  input: BrowserMembershipContext & { token: string },
  exec?: Executor,
) {
  const token = z.string().min(14).max(128).parse(input.token);
  const parsed = parseInviteToken(token);
  if (!parsed) throw new MembershipInviteError("invite_invalid");
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const proof = await browserMembershipIdentity(input, tx);
    // tenant-filter:exempt — a secret invite token discovers its destination before membership exists.
    const [invite] = await tx
      .select()
      .from(userInvites)
      .where(and(eq(userInvites.prefix, parsed.prefix), eq(userInvites.token_sha256, parsed.hash)))
      .for("update")
      .limit(1);
    if (!invite || !constantTimeHexEquals(invite.token_sha256, parsed.hash)) {
      throw new MembershipInviteError("invite_invalid");
    }
    await assertTenantActive(invite.tenant_id, tx);
    if (invite.revoked_at || invite.expires_at.getTime() <= now()) {
      throw new MembershipInviteError("invite_unavailable");
    }
    if (
      !invite.scopes.includes("*") ||
      invite.allowed_connectors !== null ||
      invite.allowed_workflows !== null
    ) {
      throw new MembershipInviteError("invite_credential_only");
    }
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, invite.user_id), eq(users.tenant_id, invite.tenant_id)))
      .for("update")
      .limit(1);
    // tenant-filter:exempt — verified browser session provenance establishes the global identity.
    const [identity] = await tx
      .select({ email: authIdentities.email })
      .from(authIdentities)
      .where(eq(authIdentities.id, proof.identity_id))
      .limit(1);
    if (
      !user ||
      !identity ||
      user.deleted_at ||
      (user.status !== "invited" && user.auth_identity_id !== proof.identity_id) ||
      user.email.trim().toLowerCase() !== identity.email.trim().toLowerCase() ||
      (user.auth_identity_id !== null && user.auth_identity_id !== proof.identity_id)
    ) {
      throw new MembershipInviteError("invite_identity_mismatch");
    }
    if (invite.redeemed_at) {
      if (user.auth_identity_id !== proof.identity_id) {
        throw new MembershipInviteError("invite_unavailable");
      }
      const membership = await getMembershipForIdentity(proof.identity_id, invite.tenant_id, tx);
      if (!membership) throw new MembershipInviteError("invite_unavailable");
      return { membership, claimed: false };
    }
    const existing = await getMembershipForIdentity(proof.identity_id, invite.tenant_id, tx);
    if (existing && existing.user_id !== user.id) {
      throw new MembershipInviteError("invite_identity_mismatch");
    }
    const timestamp = new Date(now());
    await tx
      .update(users)
      .set({ auth_identity_id: proof.identity_id, status: "active", updated_at: timestamp })
      .where(and(eq(users.id, user.id), eq(users.tenant_id, invite.tenant_id)));
    await tx
      .update(userInvites)
      .set({ redeemed_at: timestamp, updated_at: timestamp })
      .where(
        and(
          eq(userInvites.id, invite.id),
          eq(userInvites.tenant_id, invite.tenant_id),
          isNull(userInvites.redeemed_at),
        ),
      );
    await auditAwait(
      {
        tenant_id: invite.tenant_id,
        actor_type: "user",
        actor_id: user.id,
        action: AuditAction.INVITE_REDEEMED,
        resource_type: "user_invite",
        resource_id: invite.id,
        result: "success",
        metadata: { via: "verified_browser_membership", auth_identity_id: proof.identity_id },
      },
      tx,
    );
    const membership = await getMembershipForIdentity(proof.identity_id, invite.tenant_id, tx);
    if (!membership) throw new MembershipInviteError("invite_unavailable");
    return { membership, claimed: true };
  });
}

export async function membershipInviteLoginTarget(token: string, exec?: Executor) {
  const parsed = parseInviteToken(z.string().min(14).max(128).parse(token));
  if (!parsed) throw new MembershipInviteError("invite_invalid");
  const db = exec ?? getDb();
  // tenant-filter:exempt — a secret invite token discovers the login destination before any identity is authenticated.
  const [invite] = await db
    .select()
    .from(userInvites)
    .where(and(eq(userInvites.prefix, parsed.prefix), eq(userInvites.token_sha256, parsed.hash)))
    .limit(1);
  if (!invite || !constantTimeHexEquals(invite.token_sha256, parsed.hash))
    throw new MembershipInviteError("invite_invalid");
  await assertTenantActive(invite.tenant_id, db);
  if (invite.revoked_at || invite.redeemed_at || invite.expires_at.getTime() <= now())
    throw new MembershipInviteError("invite_unavailable");
  if (
    !invite.scopes.includes("*") ||
    invite.allowed_connectors !== null ||
    invite.allowed_workflows !== null
  )
    throw new MembershipInviteError("invite_credential_only");
  return { invite_id: invite.id, tenant_id: invite.tenant_id };
}

export async function acceptVerifiedMembershipInvite(
  raw: VerifiedSelfServiceIdentity,
  inviteId: string,
  exec?: Executor,
) {
  const input = parseVerifiedSelfServiceIdentity(raw);
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.issuer_url, input.subject])}, 0))`,
    );
    // tenant-filter:exempt — the server-held OIDC state carries an invitation id validated from its secret token at login start.
    const [invite] = await tx
      .select()
      .from(userInvites)
      .where(eq(userInvites.id, inviteId))
      .for("update")
      .limit(1);
    if (!invite || invite.revoked_at || invite.expires_at.getTime() <= now())
      throw new MembershipInviteError("invite_unavailable");
    await assertTenantActive(invite.tenant_id, tx);
    if (
      !invite.scopes.includes("*") ||
      invite.allowed_connectors !== null ||
      invite.allowed_workflows !== null
    )
      throw new MembershipInviteError("invite_credential_only");
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, invite.user_id), eq(users.tenant_id, invite.tenant_id)))
      .for("update")
      .limit(1);
    if (
      !user ||
      user.deleted_at ||
      user.status === "disabled" ||
      user.email.trim().toLowerCase() !== input.email
    )
      throw new MembershipInviteError("invite_identity_mismatch");
    // tenant-filter:exempt — verified OIDC issuer and subject establish a global identity without email-based account linking.
    const [existing] = await tx
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.issuer_url, input.issuer_url),
          eq(authIdentities.subject, input.subject),
        ),
      )
      .limit(1);
    if (
      (user.auth_identity_id !== null && user.auth_identity_id !== existing?.id) ||
      (user.status !== "invited" && user.auth_identity_id !== existing?.id) ||
      (invite.redeemed_at && user.auth_identity_id !== existing?.id)
    )
      throw new MembershipInviteError("invite_identity_mismatch");
    const identity =
      existing ??
      (
        await tx
          .insert(authIdentities)
          .values({ issuer_url: input.issuer_url, subject: input.subject, email: input.email })
          .returning()
      )[0];
    if (!identity) throw new MembershipInviteError("invite_unavailable");
    const current = await getMembershipForIdentity(identity.id, invite.tenant_id, tx);
    if (current && current.user_id !== user.id)
      throw new MembershipInviteError("invite_identity_mismatch");
    const timestamp = new Date(now());
    if (!invite.redeemed_at) {
      await tx
        .update(users)
        .set({ auth_identity_id: identity.id, status: "active", updated_at: timestamp })
        .where(and(eq(users.id, user.id), eq(users.tenant_id, invite.tenant_id)));
      await tx
        .update(userInvites)
        .set({ redeemed_at: timestamp, updated_at: timestamp })
        .where(and(eq(userInvites.id, invite.id), eq(userInvites.tenant_id, invite.tenant_id)));
      await auditAwait(
        {
          tenant_id: invite.tenant_id,
          actor_type: "user",
          actor_id: user.id,
          action: AuditAction.INVITE_REDEEMED,
          resource_type: "user_invite",
          resource_id: invite.id,
          result: "success",
          metadata: { via: "verified_oidc_membership", auth_identity_id: identity.id },
        },
        tx,
      );
    }
    if (identity.email !== input.email) {
      await tx
        .update(authIdentities)
        .set({ email: input.email, updated_at: timestamp })
        .where(eq(authIdentities.id, identity.id));
      await auditAwait(
        {
          tenant_id: invite.tenant_id,
          actor_type: "user",
          actor_id: user.id,
          action: AuditAction.USER_PROFILE_UPDATED,
          resource_type: "auth_identity",
          resource_id: identity.id,
          result: "success",
          metadata: { source: "verified_oidc_email_update" },
        },
        tx,
      );
    }
    const membership = await getMembershipForIdentity(identity.id, invite.tenant_id, tx);
    const [tenant] = await tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, invite.tenant_id))
      .limit(1);
    if (!membership || !tenant) throw new MembershipInviteError("invite_unavailable");
    return { identity, tenant, membership };
  });
}
