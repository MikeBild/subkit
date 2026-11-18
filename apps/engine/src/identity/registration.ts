import { eq } from "drizzle-orm";
import { clearBrowserSessionCookie } from "../auth/browser-session.ts";
import { getConfig } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import { consumePersistentRateLimits, rateLimitBucketKey } from "../db/rate-limits.ts";
import { authIdentities, tenants } from "../db/schema/index.ts";
import {
  clearIdentityProofCookie,
  consumeIdentityProof,
  type IdentityProof,
  type IdentityProofKind,
  identityProofCsrfAccepted,
  issueIdentityProof,
  readIdentityProof,
  revokeIdentityProof,
  signIdentityProofCsrf,
} from "./identity-proof.ts";

const REGISTRATION: IdentityProofKind = {
  purpose: "identity_registration",
  cookie: "subkit_identity_registration",
  issuer: "subkit:identity-registration",
  csrf_issuer: "subkit:identity-registration-csrf",
  csrf_header: "x-subkit-onboarding-csrf",
  ttl_ms: 30 * 60_000,
};

export const REGISTRATION_WELCOME_PATH = "/cockpit/welcome";
const REGISTRATION_DEFAULT_DESTINATION = "/cockpit";
const DISPLAY_NAME_MAX = 120;
export const REGISTRATION_REDIRECT_MAX = 2048;
export const REGISTRATION_PROBE_ATTEMPTS = 5;

export class PendingRegistrationError extends Error {
  constructor(readonly code: "registration_pending_required" | "registration_csrf_rejected") {
    super(code);
    this.name = "PendingRegistrationError";
  }
}

export function clearPendingRegistrationCookie(): string {
  return clearIdentityProofCookie(REGISTRATION);
}

export async function issuePendingRegistration(
  input: {
    identity_id: string;
    login_provider: string;
    redirect_to: string | null;
    suggested_display_name: unknown;
  },
  db: Executor,
): Promise<Response> {
  const suggested =
    typeof input.suggested_display_name === "string"
      ? input.suggested_display_name.trim().slice(0, DISPLAY_NAME_MAX)
      : "";
  const issued = await issueIdentityProof(
    REGISTRATION,
    input.identity_id,
    {
      login_provider: input.login_provider,
      ...(input.redirect_to ? { redirect_to: input.redirect_to } : {}),
      ...(suggested ? { display_name: suggested } : {}),
    },
    db,
  );
  const headers = new Headers({ location: REGISTRATION_WELCOME_PATH, "cache-control": "no-store" });
  headers.append("set-cookie", clearBrowserSessionCookie());
  headers.append("set-cookie", issued.cookie);
  return new Response(null, { status: 302, headers });
}

async function identityEmail(proof: IdentityProof, db: Executor): Promise<string> {
  // tenant-filter:exempt — a verified registration proof names a global identity that has no workspace yet.
  const [identity] = await db
    .select({ email: authIdentities.email })
    .from(authIdentities)
    .where(eq(authIdentities.id, proof.identity_id))
    .limit(1);
  if (!identity) throw new PendingRegistrationError("registration_pending_required");
  return identity.email;
}

export async function readPendingRegistration(request: Request, db: Executor) {
  const proof = await readIdentityProof(REGISTRATION, request, db);
  if (!proof || proof.consumed) throw new PendingRegistrationError("registration_pending_required");
  return {
    email: await identityEmail(proof, db),
    suggested_display_name: proof.context.display_name ?? null,
    csrf_token: await signIdentityProofCsrf(REGISTRATION, proof),
    expires_at: proof.expires_at,
  };
}

export async function verifyPendingRegistration(
  request: Request,
  db: Executor,
): Promise<IdentityProof> {
  const proof = await readIdentityProof(REGISTRATION, request, db);
  if (!proof) throw new PendingRegistrationError("registration_pending_required");
  if (!(await identityProofCsrfAccepted(REGISTRATION, request, proof)))
    throw new PendingRegistrationError("registration_csrf_rejected");
  return proof;
}

export async function findOwnedWorkspaceId(
  identityId: string,
  db: Executor,
): Promise<string | null> {
  // tenant-filter:exempt — a verified registration proof names a global identity; the lookup finds the one workspace it owns.
  const [owned] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.owner_identity_id, identityId))
    .limit(1);
  return owned?.id ?? null;
}

export async function admitRegistrationProbe(proof: IdentityProof, db: Executor): Promise<boolean> {
  return consumePersistentRateLimits(
    [
      {
        bucket_key: rateLimitBucketKey(
          getConfig().auth.session.secret,
          "admission",
          `registration_probe:${proof.proof_id}`,
        ),
        max: REGISTRATION_PROBE_ATTEMPTS,
        window: "month",
      },
    ],
    db,
  );
}

export async function finishPendingRegistration(
  proof: IdentityProof,
  db: Executor,
): Promise<string> {
  await db.transaction((tx) => consumeIdentityProof(proof, "registration_completed", tx));
  return proof.context.redirect_to ?? REGISTRATION_DEFAULT_DESTINATION;
}

export async function abandonPendingRegistration(
  request: Request,
  db: Executor,
): Promise<{ login_provider: string | null } | null> {
  const proof = await readIdentityProof(REGISTRATION, request, db);
  if (!proof) return null;
  await db.transaction((tx) => revokeIdentityProof(proof, "user_logout", tx));
  return { login_provider: proof.context.login_provider ?? null };
}
