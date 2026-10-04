import { describe, expect, test } from "bun:test";
import { computeSlackSignature, verifySlackRequest } from "../verifier.ts";

const SIGNING_SECRET = "subkit-test-secret";
const TIMESTAMP = "1700000000";
const BODY = "payload=hello";
const NOW = () => 1700000000_000;

describe("slack verifier", () => {
  test("computes the expected v0 signature for a known vector", () => {
    const sig = computeSlackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
    expect(sig).toBe("v0=1d26ac0554b3c4590518ad1ed0ba370c90efd8ec3e09632e35429e15a6502485");
    const res = verifySlackRequest(
      { timestamp: TIMESTAMP, signature: sig, body: BODY },
      { signingSecret: SIGNING_SECRET, now: NOW },
    );
    expect(res.ok).toBe(true);
  });

  test("rejects a body mutation with bad_signature", () => {
    const sig = computeSlackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
    const res = verifySlackRequest(
      { timestamp: TIMESTAMP, signature: sig, body: "payload=tampered" },
      { signingSecret: SIGNING_SECRET, now: NOW },
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("bad_signature");
  });

  test("rejects stale timestamps outside the 5 minute window", () => {
    const sig = computeSlackSignature(SIGNING_SECRET, TIMESTAMP, BODY);
    const res = verifySlackRequest(
      { timestamp: TIMESTAMP, signature: sig, body: BODY },
      { signingSecret: SIGNING_SECRET, now: () => (Number(TIMESTAMP) + 10 * 60) * 1000 },
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("stale");
  });
});
