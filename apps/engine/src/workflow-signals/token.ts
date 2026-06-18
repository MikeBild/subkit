// HMAC-signed approval token for wait-for-event signal links.
//
// Use case: the wait-for-event step mints a one-shot approval URL when
// it starts. The URL is delivered out-of-band (Slack button, email)
// and lets an external approver POST a signal back without holding an
// API key. The token's payload is the (tenant_id, execution_id,
// event_name) tuple plus an `expires_at` claim; the route verifies
// the signature, checks the expiry, and only then writes a
// `workflow_signals` row.
//
// Design choices:
//   - Reuses `webhooks/outbound/signer.ts` for the HMAC primitive
//     (HMAC-SHA256 + dual-secret rotation overlap).
//   - Token shape: `v1,<base64-payload>,<base64-mac>`. Payload is a
//     JSON object so adding a `kid` claim later is non-breaking.
//   - Master secret comes from `env.WAIT_FOR_EVENT_HMAC_SECRET` so an
//     operator can rotate it independently of webhook secrets.
//   - Expiry baked into the payload so a stolen token is bounded by
//     the wait_for_event timeout, not the master secret lifetime.

import { signatureHeader, verifySignatureHeader } from "../webhooks/outbound/signer.ts";

interface SignalTokenClaims {
  tenant_id: string;
  execution_id: string;
  event_name: string;
  expires_at: number; // unix seconds
}

function getSecret(): string {
  const s = process.env.WAIT_FOR_EVENT_HMAC_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "WAIT_FOR_EVENT_HMAC_SECRET is unset or too short (>= 16 chars). Set it in subkit.config.json or the engine env.",
    );
  }
  return s;
}

function getRotatingSecret(): string | null {
  const s = process.env.WAIT_FOR_EVENT_HMAC_SECRET_PREVIOUS;
  return s && s.length >= 16 ? s : null;
}

function b64encode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64decode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Mint a signal token for an inflight wait-for-event step. The
 *  signer's `timestamp` slot is fixed at 0 so the signing base is
 *  reproducible at verify time without the verifier needing the issued
 *  timestamp. Replay protection is enforced via `claims.expires_at`. */
export function mintSignalToken(claims: SignalTokenClaims): string {
  const payload = b64encode(JSON.stringify(claims));
  const sig = signatureHeader({
    webhook_id: claims.execution_id,
    timestamp: 0,
    body: payload,
    secret: getSecret(),
    rotatingSecret: getRotatingSecret(),
  });
  return `v1,${payload},${sig}`;
}

export interface VerifySignalTokenOk {
  ok: true;
  claims: SignalTokenClaims;
}
export interface VerifySignalTokenErr {
  ok: false;
  reason: "malformed" | "signature_mismatch" | "expired" | "claim_mismatch";
}

/** Verify a signal token against the expected (tenant, execution, event)
 *  triple. Wrong signature, expired, or claim mismatch all fail closed. */
export function verifySignalToken(
  token: string,
  expected: { tenant_id: string; execution_id: string; event_name: string },
): VerifySignalTokenOk | VerifySignalTokenErr {
  const parts = token.split(",");
  if (parts.length < 3 || parts[0] !== "v1") {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = parts[1]!;
  const sigHeader = parts.slice(2).join(",");
  let claims: SignalTokenClaims;
  try {
    claims = JSON.parse(b64decode(payloadB64)) as SignalTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims.tenant_id !== expected.tenant_id ||
    claims.execution_id !== expected.execution_id ||
    claims.event_name !== expected.event_name
  ) {
    return { ok: false, reason: "claim_mismatch" };
  }
  // Reconstruct the signed base. Note: `webhooks/outbound/signer.ts`
  // base = `${webhook_id}.${timestamp}.${body}` — but our verifier
  // doesn't carry the timestamp from issuance. We accept the verifier
  // contract by re-signing against the timestamps embedded in the
  // signature header rather than recomputing. The HMAC primitive's
  // verifier walks the header tokens directly.
  // Use both current + rotating secret so a token minted under the
  // previous secret still verifies during a rotation overlap.
  const secrets: string[] = [getSecret()];
  const rotating = getRotatingSecret();
  if (rotating) secrets.push(rotating);
  // The signer's base uses the timestamp at sign-time. We don't ship
  // the timestamp inside the token; instead we lean on `expires_at` in
  // the claims for replay protection. To keep the existing signer's
  // contract, sign-and-verify is parameterised by `webhook_id =
  // execution_id` and `body = payloadB64` only — the timestamp slot
  // is fixed to "0" so the signer's base is deterministic across
  // mint/verify boundaries.
  const base = `${expected.execution_id}.0.${payloadB64}`;
  const sigOk = verifySignatureHeader(sigHeader, base, secrets);
  if (!sigOk) return { ok: false, reason: "signature_mismatch" };
  if (claims.expires_at * 1000 < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
