// HMAC presign token tests — mintLocalPresignToken + verifyLocalPresignToken.
//
// Primes the config layer with a known secret via `loadConfig` so the
// token functions can run fully without a DB or HTTP stack.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import type { LocalPresignClaims } from "./object-store.ts";
import { mintLocalPresignToken, verifyLocalPresignToken } from "./object-store.ts";

let cfgDir: string;

beforeAll(async () => {
  cfgDir = mkdtempSync(join(tmpdir(), "sk-hmac-test-"));
  _resetConfigForTests();
  // Load a minimal config so `auth.session.secret` is auto-generated.
  await loadConfig({
    env: { DATABASE_URL: "postgres://localhost/test", NODE_ENV: "test" },
    configPathOverride: join(cfgDir, "subkit.config.json"),
  });
});

afterEach(() => {
  // Do NOT reset the config between individual tests — we need the same
  // session secret throughout the suite so token round-trips are stable.
});

process.on("exit", () => {
  try {
    rmSync(cfgDir, { recursive: true, force: true });
  } catch {}
});

function validClaims(overrides?: Partial<LocalPresignClaims>): LocalPresignClaims {
  return {
    tenant_id: "tenant-abc",
    key: "tenants/tenant-abc/2024/01/01/file-uuid",
    // verifyLocalPresignToken reads real wall-clock via Date.now(), so
    // these timestamps must be live too — getTestNow() falls through to
    // Date.now() when no test clock is installed.
    expires_at: getTestNow() + 60_000,
    size_bytes: 1024,
    ...overrides,
  };
}

describe("mintLocalPresignToken + verifyLocalPresignToken", () => {
  test("round-trip succeeds with valid claims", () => {
    const claims = validClaims();
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.tenant_id).toBe(claims.tenant_id);
      expect(result.claims.key).toBe(claims.key);
      expect(result.claims.size_bytes).toBe(1024);
    }
  });

  test("size_bytes is preserved in round-trip claims", () => {
    const claims = validClaims({ size_bytes: 2048 });
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.size_bytes).toBe(2048);
    }
  });

  test("size_bytes=0 (zero bytes) is accepted as a valid claim", () => {
    const claims = validClaims({ size_bytes: 0 });
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(true);
  });

  test("expired token is rejected with reason='expired'", () => {
    const claims = validClaims({ expires_at: getTestNow() - 1_000 });
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  test("tampered payload is rejected (signature_mismatch or malformed)", () => {
    const claims = validClaims();
    const token = mintLocalPresignToken(claims);
    // Flip one char in the payload portion.
    const dot = token.lastIndexOf(".");
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const tamperedPayload = payload.slice(0, -1) + (payload.slice(-1) === "A" ? "B" : "A");
    const tampered = `${tamperedPayload}.${mac}`;
    const result = verifyLocalPresignToken(tampered, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["signature_mismatch", "malformed"]).toContain(result.reason);
    }
  });

  test("tampered MAC is rejected (signature_mismatch)", () => {
    const claims = validClaims();
    const token = mintLocalPresignToken(claims);
    const dot = token.lastIndexOf(".");
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const tamperedMac = mac.slice(0, -1) + (mac.slice(-1) === "A" ? "B" : "A");
    const tampered = `${payload}.${tamperedMac}`;
    const result = verifyLocalPresignToken(tampered, {
      tenant_id: claims.tenant_id,
      key: claims.key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  test("cross-tenant use is rejected (tenant_id mismatch → signature_mismatch)", () => {
    const claims = validClaims();
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: "different-tenant",
      key: claims.key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  test("wrong key is rejected (key mismatch → signature_mismatch)", () => {
    const claims = validClaims();
    const token = mintLocalPresignToken(claims);
    const result = verifyLocalPresignToken(token, {
      tenant_id: claims.tenant_id,
      key: "some/other/key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  test("malformed token (no dot separator) is rejected with reason='malformed'", () => {
    const result = verifyLocalPresignToken("notavalidtoken", {
      tenant_id: "t",
      key: "k",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  test("token with leading dot only is rejected", () => {
    const result = verifyLocalPresignToken(".mac", { tenant_id: "t", key: "k" });
    expect(result.ok).toBe(false);
  });

  test("empty string token is rejected", () => {
    const result = verifyLocalPresignToken("", { tenant_id: "t", key: "k" });
    expect(result.ok).toBe(false);
  });
});
