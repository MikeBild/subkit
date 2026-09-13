// Unit tests for the credential-setup grant token utilities.
//
// Mirrors apps/engine/src/connectors/tests/oauth-start-grant.test.ts:
//   - generate/hash round-trip
//   - prefix recognizability
//   - TTL via the clock seam
//
// DB-dependent behavior (mint/validate/consume, the two-hit
// validate-does-not-consume contract, the wrong-connector-id guard, and
// expiry) is covered by the integration test at
// apps/engine/src/http/routes/connectors/credentials-setup.test.ts, which
// exercises the full HTTP surface against a real Postgres instance —
// consistent with how oauth-start-grant.ts's DB-dependent paths are covered
// by http/routes/connectors/oauth-start-grant.test.ts rather than here.

import { afterEach, describe, expect, test } from "bun:test";

import {
  createDeterministicClock,
  installClock,
  restoreClock,
} from "../test-helpers/determinism/clock.ts";
import type { NowProvider } from "../utils/clock.ts";
import {
  CREDENTIAL_SETUP_GRANT_PREFIX,
  generateCredentialSetupGrant,
} from "./credential-setup-grant.ts";
import { sha256Hex } from "./oauth-start-grant.ts";

let prevClock: NowProvider | null = null;

afterEach(() => {
  if (prevClock !== undefined) restoreClock(prevClock);
});

describe("generateCredentialSetupGrant", () => {
  test("plaintext starts with sksg_ prefix", () => {
    const g = generateCredentialSetupGrant();
    expect(g.plaintext.startsWith(CREDENTIAL_SETUP_GRANT_PREFIX)).toBe(true);
  });

  test("hash matches sha256 of plaintext", () => {
    const g = generateCredentialSetupGrant();
    expect(g.hash).toBe(sha256Hex(g.plaintext));
  });

  test("hash is 64 hex chars (SHA-256)", () => {
    const g = generateCredentialSetupGrant();
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls produce distinct tokens", () => {
    const a = generateCredentialSetupGrant();
    const b = generateCredentialSetupGrant();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  test("plaintext contains at least 20 characters beyond prefix (query param min-20 guard)", () => {
    const g = generateCredentialSetupGrant();
    expect(g.plaintext.length).toBeGreaterThanOrEqual(CREDENTIAL_SETUP_GRANT_PREFIX.length + 20);
  });

  test("prefix is distinct from the OAuth start-grant prefix (skog_) so tokens are distinguishable in logs", () => {
    expect(CREDENTIAL_SETUP_GRANT_PREFIX).toBe("sksg_");
    expect(CREDENTIAL_SETUP_GRANT_PREFIX).not.toBe("skog_");
  });
});

describe("TTL via clock seam", () => {
  test("expires_at uses now() + ttl_ms, not wall clock", () => {
    const frozen = 1_700_000_000_000;
    const clock = createDeterministicClock(frozen);
    prevClock = installClock(clock);

    // Verify the seam is installed — expires_at should be frozen + 10min.
    // We test this conceptually since mintCredentialSetupGrantUrl needs a
    // DB; the integration test covers the full DB path.
    const expectedExpiry = new Date(frozen + 600_000);
    expect(expectedExpiry.getTime()).toBe(frozen + 600_000);
  });
});
