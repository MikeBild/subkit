import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import * as jose from "jose";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import { browserSessionSecret, clearBrowserSessionCookie } from "../auth/browser-session.ts";
import type { Executor } from "../db/client.ts";
import { authIdentities, identityRecoverySessions, tenants } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { constantTimeHexEquals } from "./api-key.ts";
import {
  parseVerifiedSelfServiceIdentity,
  type VerifiedSelfServiceIdentity,
} from "./self-service.ts";

const RECOVERY_COOKIE = "subkit_identity_recovery";
const RECOVERY_ISSUER = "subkit:identity-recovery";
const RECOVERY_CSRF_ISSUER = "subkit:identity-recovery-csrf";
const RECOVERY_TTL_MS = 5 * 60_000;
const ProofSchema = z.object({
  purpose: z.literal("identity_recovery"),
  identity_id: z.uuid(),
  recovery_id: z.uuid(),
});

export class IdentityRecoveryError extends Error {
  constructor(readonly code: "recovery_unavailable" | "recovery_csrf_rejected") {
    super(code);
    this.name = "IdentityRecoveryError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function recoveryCookie(token: string): string {
  const secure = process.env.NODE_ENV !== "development" ? "; Secure" : "";
  return `${RECOVERY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${RECOVERY_TTL_MS / 1000}${secure}`;
}

function cookieToken(request: Request): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${RECOVERY_COOKIE}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(RECOVERY_COOKIE.length + 1));
  } catch {
    return null;
  }
}

export async function issueIdentityRecovery(
  raw: VerifiedSelfServiceIdentity,
  db: Executor,
): Promise<Response> {
  const input = parseVerifiedSelfServiceIdentity(raw);
  // tenant-filter:exempt — fresh verified OIDC issuer and subject establish an identity without tenant authority.
  const [identity] = await db
    .select({ id: authIdentities.id })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.issuer_url, input.issuer_url),
        eq(authIdentities.subject, input.subject),
      ),
    )
    .limit(1);
  if (!identity) throw new IdentityRecoveryError("recovery_unavailable");
  const recoveryId = randomUUID();
  const expiresAt = new Date(now() + RECOVERY_TTL_MS);
  const token = await new jose.SignJWT({
    purpose: "identity_recovery",
    identity_id: identity.id,
    recovery_id: recoveryId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(RECOVERY_ISSUER)
    .setAudience(RECOVERY_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(browserSessionSecret());
  await db.transaction(async (tx) => {
    await tx.insert(identityRecoverySessions).values({
      id: recoveryId,
      auth_identity_id: identity.id,
      token_sha256: hashToken(token),
      expires_at: expiresAt,
    });
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SESSION_ISSUED,
        resource_type: "identity_recovery_session",
        resource_id: recoveryId,
        result: "success",
        metadata: { purpose: "identity_recovery", auth_identity_id: identity.id },
      },
      tx,
    );
  });
  const headers = new Headers({ location: "/cockpit/recovery", "cache-control": "no-store" });
  headers.append("set-cookie", clearBrowserSessionCookie());
  headers.append("set-cookie", recoveryCookie(token));
  return new Response(null, { status: 302, headers });
}

export async function identityRecoveryFromRequest(request: Request, db: Executor) {
  const token = cookieToken(request);
  if (!token) throw new IdentityRecoveryError("recovery_unavailable");
  let claims: z.infer<typeof ProofSchema>;
  try {
    const { payload } = await jose.jwtVerify(token, browserSessionSecret(), {
      issuer: RECOVERY_ISSUER,
      audience: RECOVERY_ISSUER,
      algorithms: ["HS256"],
    });
    claims = ProofSchema.parse(payload);
  } catch {
    throw new IdentityRecoveryError("recovery_unavailable");
  }
  // tenant-filter:exempt — recovery sessions authenticate a global identity and never establish a tenant principal.
  const [session] = await db
    .select()
    .from(identityRecoverySessions)
    .where(
      and(
        eq(identityRecoverySessions.id, claims.recovery_id),
        eq(identityRecoverySessions.auth_identity_id, claims.identity_id),
      ),
    )
    .limit(1);
  if (
    !session ||
    session.consumed_at ||
    session.expires_at.getTime() <= now() ||
    !constantTimeHexEquals(session.token_sha256, hashToken(token))
  )
    throw new IdentityRecoveryError("recovery_unavailable");
  return {
    identity_id: claims.identity_id,
    recovery_id: session.id,
    expires_at: session.expires_at,
  };
}

async function recoveryCsrf(proof: Awaited<ReturnType<typeof identityRecoveryFromRequest>>) {
  return new jose.SignJWT({
    purpose: "identity_recovery_csrf",
    identity_id: proof.identity_id,
    recovery_id: proof.recovery_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(RECOVERY_CSRF_ISSUER)
    .setAudience(RECOVERY_CSRF_ISSUER)
    .setExpirationTime(Math.floor(proof.expires_at.getTime() / 1000))
    .sign(browserSessionSecret());
}

export async function readIdentityRecovery(request: Request, db: Executor) {
  const proof = await identityRecoveryFromRequest(request, db);
  const [tenant] = await db
    .select({
      id: tenants.id,
      display_name: tenants.display_name,
      status: tenants.status,
      deletion_scheduled_for: tenants.deletion_scheduled_for,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.owner_identity_id, proof.identity_id),
        eq(tenants.origin, "self_service"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  return {
    tenant: tenant ?? null,
    can_restore:
      tenant?.status === "pending_deletion" &&
      tenant.deletion_scheduled_for !== null &&
      tenant.deletion_scheduled_for.getTime() > now(),
    csrf_token: await recoveryCsrf(proof),
    expires_at: proof.expires_at,
  };
}

export async function consumeIdentityRecovery<T>(
  request: Request,
  operation: (identityId: string, tx: Executor) => Promise<T>,
  db: Executor,
): Promise<T> {
  const proof = await identityRecoveryFromRequest(request, db);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new IdentityRecoveryError("recovery_csrf_rejected");
  try {
    const { payload } = await jose.jwtVerify(
      request.headers.get("x-subkit-recovery-csrf") ?? "",
      browserSessionSecret(),
      { issuer: RECOVERY_CSRF_ISSUER, audience: RECOVERY_CSRF_ISSUER, algorithms: ["HS256"] },
    );
    if (
      payload.purpose !== "identity_recovery_csrf" ||
      payload.recovery_id !== proof.recovery_id ||
      payload.identity_id !== proof.identity_id
    )
      throw new Error("invalid csrf");
  } catch {
    throw new IdentityRecoveryError("recovery_csrf_rejected");
  }
  return db.transaction(async (tx) => {
    // tenant-filter:exempt — one-time global identity recovery is locked independently of all tenant sessions.
    const [session] = await tx
      .select()
      .from(identityRecoverySessions)
      .where(
        and(
          eq(identityRecoverySessions.id, proof.recovery_id),
          eq(identityRecoverySessions.auth_identity_id, proof.identity_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!session || session.consumed_at || session.expires_at.getTime() <= now())
      throw new IdentityRecoveryError("recovery_unavailable");
    const result = await operation(proof.identity_id, tx);
    await tx
      .update(identityRecoverySessions)
      .set({ consumed_at: new Date(now()) })
      .where(
        and(
          eq(identityRecoverySessions.id, proof.recovery_id),
          eq(identityRecoverySessions.auth_identity_id, proof.identity_id),
        ),
      );
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SESSION_REVOKED,
        resource_type: "identity_recovery_session",
        resource_id: proof.recovery_id,
        result: "success",
        reason: "recovery_consumed",
      },
      tx,
    );
    return result;
  });
}
