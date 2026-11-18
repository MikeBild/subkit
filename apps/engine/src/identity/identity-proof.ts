import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import * as jose from "jose";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import { browserSessionSecret } from "../auth/browser-session.ts";
import type { Executor } from "../db/client.ts";
import { identityRecoverySessions } from "../db/schema/index.ts";
import { now } from "../utils/clock.ts";
import { constantTimeHexEquals } from "./api-key.ts";

export interface IdentityProofKind {
  readonly purpose: string;
  readonly cookie: string;
  readonly issuer: string;
  readonly csrf_issuer: string;
  readonly csrf_header: string;
  readonly ttl_ms: number;
}

export interface IdentityProof {
  readonly identity_id: string;
  readonly proof_id: string;
  readonly expires_at: Date;
  readonly consumed: boolean;
  readonly context: Readonly<Record<string, string>>;
}

const ProofSchema = z.object({
  purpose: z.string(),
  identity_id: z.uuid(),
  proof_id: z.uuid(),
  context: z.record(z.string(), z.string()).optional(),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function secureAttribute(): string {
  return process.env.NODE_ENV !== "development" ? "; Secure" : "";
}

export function clearIdentityProofCookie(kind: IdentityProofKind): string {
  return `${kind.cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute()}`;
}

function cookieToken(kind: IdentityProofKind, request: Request): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${kind.cookie}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(kind.cookie.length + 1));
  } catch {
    return null;
  }
}

export async function issueIdentityProof(
  kind: IdentityProofKind,
  identityId: string,
  context: Readonly<Record<string, string>>,
  db: Executor,
): Promise<{ cookie: string; proof_id: string }> {
  const proofId = randomUUID();
  const expiresAt = new Date(now() + kind.ttl_ms);
  const token = await new jose.SignJWT({
    purpose: kind.purpose,
    identity_id: identityId,
    proof_id: proofId,
    context,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(kind.issuer)
    .setAudience(kind.issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(browserSessionSecret());
  await db.transaction(async (tx) => {
    await tx.insert(identityRecoverySessions).values({
      id: proofId,
      auth_identity_id: identityId,
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
        resource_id: proofId,
        result: "success",
        metadata: { purpose: kind.purpose, auth_identity_id: identityId },
      },
      tx,
    );
  });
  return {
    cookie: `${kind.cookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${kind.ttl_ms / 1000}${secureAttribute()}`,
    proof_id: proofId,
  };
}

export async function readIdentityProof(
  kind: IdentityProofKind,
  request: Request,
  db: Executor,
): Promise<IdentityProof | null> {
  const token = cookieToken(kind, request);
  if (!token) return null;
  let claims: z.infer<typeof ProofSchema>;
  try {
    const { payload } = await jose.jwtVerify(token, browserSessionSecret(), {
      issuer: kind.issuer,
      audience: kind.issuer,
      algorithms: ["HS256"],
    });
    claims = ProofSchema.parse(payload);
  } catch {
    return null;
  }
  if (claims.purpose !== kind.purpose) return null;
  // tenant-filter:exempt — identity proofs authenticate a global identity and never establish a tenant principal.
  const [session] = await db
    .select()
    .from(identityRecoverySessions)
    .where(
      and(
        eq(identityRecoverySessions.id, claims.proof_id),
        eq(identityRecoverySessions.auth_identity_id, claims.identity_id),
      ),
    )
    .limit(1);
  if (
    !session ||
    session.expires_at.getTime() <= now() ||
    !constantTimeHexEquals(session.token_sha256, hashToken(token))
  )
    return null;
  return {
    identity_id: claims.identity_id,
    proof_id: session.id,
    expires_at: session.expires_at,
    consumed: session.consumed_at !== null,
    context: claims.context ?? {},
  };
}

export async function signIdentityProofCsrf(
  kind: IdentityProofKind,
  proof: IdentityProof,
): Promise<string> {
  return new jose.SignJWT({
    purpose: `${kind.purpose}_csrf`,
    identity_id: proof.identity_id,
    proof_id: proof.proof_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(kind.csrf_issuer)
    .setAudience(kind.csrf_issuer)
    .setExpirationTime(Math.floor(proof.expires_at.getTime() / 1000))
    .sign(browserSessionSecret());
}

export async function identityProofCsrfAccepted(
  kind: IdentityProofKind,
  request: Request,
  proof: IdentityProof,
): Promise<boolean> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    const { payload } = await jose.jwtVerify(
      request.headers.get(kind.csrf_header) ?? "",
      browserSessionSecret(),
      { issuer: kind.csrf_issuer, audience: kind.csrf_issuer, algorithms: ["HS256"] },
    );
    return (
      payload.purpose === `${kind.purpose}_csrf` &&
      payload.proof_id === proof.proof_id &&
      payload.identity_id === proof.identity_id
    );
  } catch {
    return false;
  }
}

export async function revokeIdentityProof(
  proof: IdentityProof,
  reason: string,
  tx: Executor,
): Promise<void> {
  const revokedAt = new Date(now());
  // tenant-filter:exempt — a global identity proof is revoked independently of all tenant sessions.
  const [revoked] = await tx
    .update(identityRecoverySessions)
    .set({ expires_at: revokedAt, ...(proof.consumed ? {} : { consumed_at: revokedAt }) })
    .where(
      and(
        eq(identityRecoverySessions.id, proof.proof_id),
        eq(identityRecoverySessions.auth_identity_id, proof.identity_id),
        gt(identityRecoverySessions.expires_at, revokedAt),
      ),
    )
    .returning({ id: identityRecoverySessions.id });
  if (!revoked) return;
  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SESSION_REVOKED,
      resource_type: "identity_recovery_session",
      resource_id: proof.proof_id,
      result: "success",
      reason,
    },
    tx,
  );
}

export async function consumeIdentityProof(
  proof: IdentityProof,
  reason: string,
  tx: Executor,
): Promise<boolean> {
  // tenant-filter:exempt — a one-time global identity proof is locked independently of all tenant sessions.
  const [session] = await tx
    .select()
    .from(identityRecoverySessions)
    .where(
      and(
        eq(identityRecoverySessions.id, proof.proof_id),
        eq(identityRecoverySessions.auth_identity_id, proof.identity_id),
      ),
    )
    .for("update")
    .limit(1);
  if (!session || session.consumed_at || session.expires_at.getTime() <= now()) return false;
  await tx
    .update(identityRecoverySessions)
    .set({ consumed_at: new Date(now()) })
    .where(
      and(
        eq(identityRecoverySessions.id, proof.proof_id),
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
      resource_id: proof.proof_id,
      result: "success",
      reason,
    },
    tx,
  );
  return true;
}
