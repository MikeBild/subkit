import { createHmac } from "node:crypto";

export interface SignedEnvelope {
  webhook_id: string;
  timestamp: string;
  body: string;
  signature: string;
}

export interface SignOptions {
  webhook_id: string;
  timestamp: number;
  body: string;
  secret: string;
  rotatingSecret?: string | null;
}

function hmacBase64(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base, "utf8").digest("base64");
}

export function sign(opts: SignOptions): SignedEnvelope {
  const ts = String(opts.timestamp);
  const base = `${opts.webhook_id}.${ts}.${opts.body}`;
  const parts: string[] = [`v1,${hmacBase64(opts.secret, base)}`];
  if (opts.rotatingSecret) {
    parts.push(`v1,${hmacBase64(opts.rotatingSecret, base)}`);
  }
  return {
    webhook_id: opts.webhook_id,
    timestamp: ts,
    body: opts.body,
    signature: parts.join(" "),
  };
}

export function signatureHeader(opts: SignOptions): string {
  return sign(opts).signature;
}

export function verifySignatureHeader(header: string, base: string, secrets: string[]): boolean {
  const tokens = header.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    const [scheme, b64] = token.split(",");
    if (scheme !== "v1" || !b64) continue;
    for (const secret of secrets) {
      const expected = hmacBase64(secret, base);
      if (constantTimeEqual(b64, expected)) return true;
    }
  }
  return false;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
