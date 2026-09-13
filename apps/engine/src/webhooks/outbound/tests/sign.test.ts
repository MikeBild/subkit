// Signer unit tests — pure HMAC with no DB.
//
// Vector below is deterministic:
//
//   webhook_id  = "msg_test_00000000000000000000000"
//   timestamp   = 1700000000
//   body        = '{"type":"ping"}'
//   secret      = "whsec_testabcdefghijklmnopqrstuv"
//
// base         = "msg_test_00000000000000000000000.1700000000.{\"type\":\"ping\"}"
// expected     = base64(HMAC-SHA256(secret, base))

import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { sign, signatureHeader, verifySignatureHeader } from "../signer.ts";

const ID = "msg_test_00000000000000000000000";
const TS = 1_700_000_000;
const BODY = '{"type":"ping"}';
const SECRET = "whsec_testabcdefghijklmnopqrstuv";

function referenceSignature(secret: string): string {
  const base = `${ID}.${TS}.${BODY}`;
  return createHmac("sha256", secret).update(base, "utf8").digest("base64");
}

describe("signer: single signature", () => {
  test("matches a known HMAC vector", () => {
    const env = sign({ webhook_id: ID, timestamp: TS, body: BODY, secret: SECRET });
    const expected = referenceSignature(SECRET);
    expect(env.signature).toBe(`v1,${expected}`);
    expect(env.webhook_id).toBe(ID);
    expect(env.timestamp).toBe(String(TS));
    // Stability check — regenerate and confirm idempotency.
    expect(signatureHeader({ webhook_id: ID, timestamp: TS, body: BODY, secret: SECRET })).toBe(
      env.signature,
    );
  });

  test("verifier accepts the produced header", () => {
    const header = signatureHeader({
      webhook_id: ID,
      timestamp: TS,
      body: BODY,
      secret: SECRET,
    });
    const ok = verifySignatureHeader(header, `${ID}.${TS}.${BODY}`, [SECRET]);
    expect(ok).toBe(true);
  });

  test("verifier rejects a tampered header", () => {
    const header = signatureHeader({
      webhook_id: ID,
      timestamp: TS,
      body: BODY,
      secret: SECRET,
    });
    const bad = header.replace(/.$/, (c) => (c === "=" ? "A" : "="));
    const ok = verifySignatureHeader(bad, `${ID}.${TS}.${BODY}`, [SECRET]);
    expect(ok).toBe(false);
  });
});

describe("signer: multi-sig rotation", () => {
  test("rotation emits two space-separated v1 tokens", () => {
    const rotating = "whsec_oldsecretaaaaaaaaaaaaaaaaaaaa";
    const env = sign({
      webhook_id: ID,
      timestamp: TS,
      body: BODY,
      secret: SECRET,
      rotatingSecret: rotating,
    });
    const parts = env.signature.split(" ");
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(`v1,${referenceSignature(SECRET)}`);
    expect(parts[1]).toBe(`v1,${referenceSignature(rotating)}`);
  });

  test("verifier accepts either rotation token", () => {
    const rotating = "whsec_oldsecretaaaaaaaaaaaaaaaaaaaa";
    const header = signatureHeader({
      webhook_id: ID,
      timestamp: TS,
      body: BODY,
      secret: SECRET,
      rotatingSecret: rotating,
    });
    expect(verifySignatureHeader(header, `${ID}.${TS}.${BODY}`, [SECRET])).toBe(true);
    expect(verifySignatureHeader(header, `${ID}.${TS}.${BODY}`, [rotating])).toBe(true);
    expect(verifySignatureHeader(header, `${ID}.${TS}.${BODY}`, ["someone-else"])).toBe(false);
  });
});
