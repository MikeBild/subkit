import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideSessionResolution } from "./session.ts";

const SLIDING = 10;
const ABSOLUTE = 100;

test("session resolution gives revocation and absolute expiry precedence", () => {
  expect(
    decideSessionResolution(
      { revoked_at_ms: 1, created_at_ms: 0, last_seen_at_ms: 0, absolute_expires_at_ms: 1 },
      2,
      SLIDING,
      ABSOLUTE,
    ),
  ).toEqual({ kind: "revoked" });
  expect(
    decideSessionResolution(
      { revoked_at_ms: null, created_at_ms: 0, last_seen_at_ms: 99, absolute_expires_at_ms: 10 },
      10,
      SLIDING,
      ABSOLUTE,
    ).kind,
  ).toBe("expired_absolute");
});

test("session resolution uses a strict sliding boundary and never mutates facts", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 1_000 }), (created_at_ms) => {
      const facts = Object.freeze({
        revoked_at_ms: null,
        created_at_ms,
        last_seen_at_ms: created_at_ms,
        absolute_expires_at_ms: created_at_ms + ABSOLUTE,
      });
      const before = JSON.stringify(facts);
      expect(decideSessionResolution(facts, created_at_ms + SLIDING, SLIDING, ABSOLUTE).kind).toBe(
        "active",
      );
      expect(
        decideSessionResolution(facts, created_at_ms + SLIDING + 1, SLIDING, ABSOLUTE).kind,
      ).toBe("expired_sliding");
      expect(JSON.stringify(facts)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("active sessions expose the exact injected last-seen instant including legacy fallbacks", () => {
  const facts = Object.freeze({
    revoked_at_ms: null,
    created_at_ms: 10,
    last_seen_at_ms: null,
    absolute_expires_at_ms: null,
  });
  expect(decideSessionResolution(facts, 20, SLIDING, ABSOLUTE)).toEqual({
    kind: "active",
    next_last_seen_at_ms: 20,
  });
  expect(decideSessionResolution(facts, 21, SLIDING, ABSOLUTE)).toEqual({
    kind: "expired_sliding",
    last_seen_at_ms: 10,
  });
  expect(decideSessionResolution(facts, 110, SLIDING, ABSOLUTE)).toEqual({
    kind: "expired_absolute",
    absolute_expires_at_ms: 110,
  });
  expect(decideSessionResolution(null, 20, SLIDING, ABSOLUTE)).toEqual({ kind: "not_found" });
});
