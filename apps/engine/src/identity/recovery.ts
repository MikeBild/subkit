import { and, eq, isNull } from "drizzle-orm";
import { clearBrowserSessionCookie } from "../auth/browser-session.ts";
import type { Executor } from "../db/client.ts";
import { authIdentities, tenants } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import {
  consumeIdentityProof,
  type IdentityProof,
  type IdentityProofKind,
  identityProofCsrfAccepted,
  issueIdentityProof,
  readIdentityProof,
  signIdentityProofCsrf,
} from "./identity-proof.ts";
import {
  parseVerifiedSelfServiceIdentity,
  type VerifiedSelfServiceIdentity,
} from "./self-service.ts";

const RECOVERY: IdentityProofKind = {
  purpose: "identity_recovery",
  cookie: "subkit_identity_recovery",
  issuer: "subkit:identity-recovery",
  csrf_issuer: "subkit:identity-recovery-csrf",
  csrf_header: "x-subkit-recovery-csrf",
  ttl_ms: 5 * 60_000,
};

export class IdentityRecoveryError extends Error {
  constructor(readonly code: "recovery_unavailable" | "recovery_csrf_rejected") {
    super(code);
    this.name = "IdentityRecoveryError";
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
  const issued = await issueIdentityProof(RECOVERY, identity.id, {}, db);
  const headers = new Headers({ location: "/cockpit/recovery", "cache-control": "no-store" });
  headers.append("set-cookie", clearBrowserSessionCookie());
  headers.append("set-cookie", issued.cookie);
  return new Response(null, { status: 302, headers });
}

async function recoveryProof(request: Request, db: Executor): Promise<IdentityProof> {
  const proof = await readIdentityProof(RECOVERY, request, db);
  if (!proof || proof.consumed) throw new IdentityRecoveryError("recovery_unavailable");
  return proof;
}

export async function identityRecoveryFromRequest(request: Request, db: Executor) {
  const proof = await recoveryProof(request, db);
  return {
    identity_id: proof.identity_id,
    recovery_id: proof.proof_id,
    expires_at: proof.expires_at,
  };
}

export async function readIdentityRecovery(request: Request, db: Executor) {
  const proof = await recoveryProof(request, db);
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
    csrf_token: await signIdentityProofCsrf(RECOVERY, proof),
    expires_at: proof.expires_at,
  };
}

export async function consumeIdentityRecovery<T>(
  request: Request,
  operation: (identityId: string, tx: Executor) => Promise<T>,
  db: Executor,
): Promise<T> {
  const proof = await recoveryProof(request, db);
  if (!(await identityProofCsrfAccepted(RECOVERY, request, proof)))
    throw new IdentityRecoveryError("recovery_csrf_rejected");
  return db.transaction(async (tx) => {
    if (!(await consumeIdentityProof(proof, "recovery_consumed", tx)))
      throw new IdentityRecoveryError("recovery_unavailable");
    return operation(proof.identity_id, tx);
  });
}
