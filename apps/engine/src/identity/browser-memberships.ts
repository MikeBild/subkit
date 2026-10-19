import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import { SESSION_SLIDING_TTL_MS } from "../auth/browser-session.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { sessions, users } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { getMembershipForIdentity, SelfServiceIdentityError } from "./self-service.ts";

export interface BrowserMembershipContext {
  tenant_id: string;
  user_id: string;
  session_id: string;
}

export async function browserMembershipIdentity(input: BrowserMembershipContext, exec?: Executor) {
  const db = exec ?? getDb();
  const [session] = await db
    .select({ session: sessions, auth_identity_id: users.auth_identity_id })
    .from(sessions)
    .innerJoin(users, and(eq(users.id, sessions.user_id), eq(users.tenant_id, sessions.tenant_id)))
    .where(
      and(
        eq(sessions.id, input.session_id),
        eq(sessions.tenant_id, input.tenant_id),
        eq(sessions.user_id, input.user_id),
        eq(users.status, "active"),
        isNull(users.deleted_at),
      ),
    )
    .limit(1);
  const timestamp = now();
  const proof = session?.session;
  if (
    !session ||
    !proof?.auth_identity_id ||
    proof.auth_identity_id !== session.auth_identity_id ||
    proof.product_id !== null ||
    proof.revoked_at !== null ||
    proof.expires_at.getTime() <= timestamp ||
    !proof.absolute_expires_at ||
    proof.absolute_expires_at.getTime() <= timestamp ||
    !proof.last_seen_at ||
    proof.last_seen_at.getTime() + SESSION_SLIDING_TTL_MS <= timestamp
  ) {
    throw new SelfServiceIdentityError("membership_unavailable");
  }
  if (!(await getMembershipForIdentity(proof.auth_identity_id, input.tenant_id, db))) {
    throw new SelfServiceIdentityError("membership_unavailable");
  }
  return { identity_id: proof.auth_identity_id, session: proof };
}

export async function rotateTenantSession(
  input: BrowserMembershipContext & { target_tenant_id: string },
  exec?: Executor,
) {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, input.session_id),
          eq(sessions.tenant_id, input.tenant_id),
          eq(sessions.user_id, input.user_id),
        ),
      )
      .for("update");
    const proof = await browserMembershipIdentity(input, tx);
    const membership = await getMembershipForIdentity(
      proof.identity_id,
      input.target_tenant_id,
      tx,
    );
    if (!membership) throw new SelfServiceIdentityError("membership_unavailable");
    const timestamp = new Date(now());
    const absoluteExpiry = proof.session.absolute_expires_at;
    if (!absoluteExpiry) throw new SelfServiceIdentityError("membership_unavailable");
    await tx
      .update(sessions)
      .set({ revoked_at: timestamp })
      .where(
        and(
          eq(sessions.id, input.session_id),
          eq(sessions.tenant_id, input.tenant_id),
          eq(sessions.user_id, input.user_id),
        ),
      );
    const [session] = await tx
      .insert(sessions)
      .values({
        tenant_id: membership.tenant_id,
        user_id: membership.user_id,
        auth_identity_id: proof.identity_id,
        last_seen_at: timestamp,
        expires_at: new Date(
          Math.min(timestamp.getTime() + SESSION_SLIDING_TTL_MS, absoluteExpiry.getTime()),
        ),
        absolute_expires_at: absoluteExpiry,
        token_sha256: createHash("sha256").update(randomBytes(32)).digest("hex"),
      })
      .returning();
    assertInsertRow(session, "sessions");
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: "user",
        actor_id: input.user_id,
        action: AuditAction.SESSION_REVOKED,
        resource_type: "session",
        resource_id: input.session_id,
        result: "success",
        reason: "tenant_switch",
      },
      tx,
    );
    await auditAwait(
      {
        tenant_id: membership.tenant_id,
        actor_type: "user",
        actor_id: membership.user_id,
        action: AuditAction.SESSION_ISSUED,
        resource_type: "session",
        resource_id: session.id,
        result: "success",
        metadata: { via: "tenant_switch" },
      },
      tx,
    );
    return { membership, session };
  });
}
