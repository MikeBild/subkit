import { signatureHeader, verifySignatureHeader } from "../webhooks/outbound/signer.ts";

interface SignalTokenClaims {
  tenant_id: string;
  execution_id: string;
  event_name: string;
  expires_at: number;
}

function getSecret(): string {
  const s = process.env.WAIT_FOR_EVENT_HMAC_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "WAIT_FOR_EVENT_HMAC_SECRET is unset or too short (>= 16 chars). Set it through the runtime settings API.",
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
  const secrets: string[] = [getSecret()];
  const rotating = getRotatingSecret();
  if (rotating) secrets.push(rotating);
  const base = `${expected.execution_id}.0.${payloadB64}`;
  const sigOk = verifySignatureHeader(sigHeader, base, secrets);
  if (!sigOk) return { ok: false, reason: "signature_mismatch" };
  if (claims.expires_at * 1000 < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
