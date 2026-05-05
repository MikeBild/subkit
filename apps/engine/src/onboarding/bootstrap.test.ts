// Bootstrap orchestrator tests — DB-backed via testcontainers.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../db/schema/audit.ts";
import { engineSettings, tenants } from "../db/schema/identity.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { type SeededRoleIds, seedBuiltinRolesAndPermissions } from "../rbac/seed.ts";

// settings/clearCache removed in v3.5 — runtime config moved to subkit.config.json
const clearCache = (): void => {};

import {
  _internal,
  _resetRateLimitForTests,
  BOOTSTRAP_COMPLETED_KEY,
  BOOTSTRAP_MAX_ATTEMPTS,
  BOOTSTRAP_TOKEN_KEY,
  BOOTSTRAP_TOKEN_TTL_MS,
  buildBootstrapBanner,
  consume,
  deriveTenantSlug,
  isBootstrapPending,
  run,
} from "./bootstrap.ts";

let tdb: TestDb;
let rbacIds: SeededRoleIds;

beforeAll(async () => {
  tdb = await createTestDb("onboarding-bootstrap");
  rbacIds = await seedBuiltinRolesAndPermissions(tdb.db);
});

afterAll(async () => {
  await tdb.cleanup();
});

async function resetWorld(): Promise<void> {
  // Drop everything we mutate between tests.  Order matters because of
  // FK chains coming off `tenants`.
  await tdb.db.delete(auditLog);
  await tdb.db.delete(engineSettings);
  await tdb.db.delete(tenants);
  _resetRateLimitForTests();
  clearCache();
}

beforeEach(async () => {
  await resetWorld();
});

describe("isBootstrapPending", () => {
  test("returns true when tenants empty AND sentinel unset", async () => {
    expect(await isBootstrapPending(tdb.db)).toBe(true);
  });

  test("returns false when sentinel set, even if tenants empty", async () => {
    await _internal.writeSetting(tdb.db, BOOTSTRAP_COMPLETED_KEY, true);
    expect(await isBootstrapPending(tdb.db)).toBe(false);
  });

  test("returns false when a tenant exists, even if sentinel unset", async () => {
    await tdb.db.insert(tenants).values({ slug: "existing", display_name: "Existing" });
    expect(await isBootstrapPending(tdb.db)).toBe(false);
  });
});

describe("run() — banner + token mint", () => {
  test("mints a token and prints a banner on a fresh install", async () => {
    const captured: string[] = [];
    const result = await run(tdb.db, { stdout: { write: (c) => captured.push(c) } });
    expect(result.status).toBe("minted");
    expect(result.plaintext_token).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.join("")).toContain("sk init --token");
    expect(captured.join("")).toContain(result.plaintext_token!);

    const envelope = await _internal.readSetting<{ token_sha256: string; expires_at_ms: number }>(
      tdb.db,
      BOOTSTRAP_TOKEN_KEY,
    );
    expect(envelope).toBeDefined();
    expect(envelope!.token_sha256).toBe(_internal.sha256Hex(result.plaintext_token!));
    // 15-minute TTL +/- 5s slop for clock noise during the test.
    expect(envelope!.expires_at_ms - Date.now()).toBeGreaterThan(BOOTSTRAP_TOKEN_TTL_MS - 5_000);
    expect(envelope!.expires_at_ms - Date.now()).toBeLessThanOrEqual(BOOTSTRAP_TOKEN_TTL_MS);
  });

  test("no-op when sentinel already set (no token, no banner)", async () => {
    await _internal.writeSetting(tdb.db, BOOTSTRAP_COMPLETED_KEY, true);
    const captured: string[] = [];
    const result = await run(tdb.db, { stdout: { write: (c) => captured.push(c) } });
    expect(result.status).toBe("already_completed");
    expect(captured).toEqual([]);
    expect(await _internal.readSetting(tdb.db, BOOTSTRAP_TOKEN_KEY)).toBeUndefined();
  });

  test("no-op when a tenant is already present (stale-tenants safety)", async () => {
    await tdb.db.insert(tenants).values({ slug: "stale", display_name: "Stale" });
    const captured: string[] = [];
    const result = await run(tdb.db, { stdout: { write: (c) => captured.push(c) } });
    expect(result.status).toBe("already_completed");
    expect(captured).toEqual([]);
  });
});

describe("consume() — single-use enforcement + 410 lockout", () => {
  test("happy path: creates tenant + admin + api key, writes settings, sets sentinel, deletes token, audits SETUP_COMPLETED", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const token = minted.plaintext_token!;

    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme Corp",
        llm_provider: "anthropic",
        llm_api_key: "sk-ant-test-key",
      },
      { token, ip: "127.0.0.1", user_agent: "sk/test" },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.tenant_id).toBeDefined();
    expect(outcome.api_key_plaintext).toMatch(/^wf_live_/);

    const tenantRows = await tdb.db.select().from(tenants);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.display_name).toBe("Acme Corp");
    expect(tenantRows[0]!.slug).toBe("acme-corp");

    const sentinel = await _internal.readSetting<boolean>(tdb.db, BOOTSTRAP_COMPLETED_KEY);
    expect(sentinel).toBe(true);
    const envelope = await _internal.readSetting(tdb.db, BOOTSTRAP_TOKEN_KEY);
    expect(envelope).toBeUndefined();

    // v3.5: llm.provider and llm.api_key now live in subkit.config.json,
    // not engine_settings. The bootstrap consume() path writes them via
    // setConfigKey but the loader is not initialised in this unit test
    // (the wrapper logs a skip warn). The new tenant's
    // tenant_llm_settings row carries the same config and is asserted
    // by the integration suite — see
    // apps/engine/src/http/routes/__tests__/settings.integration.test.ts.

    const completed = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "setup.completed"));
    expect(completed.length).toBe(1);
    expect(completed[0]!.tenant_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(completed[0]!.ip).toBe("127.0.0.1");
  });

  test("second call returns gone (410 lockout)", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      { token: minted.plaintext_token!, ip: "127.0.0.1" },
    );
    _resetRateLimitForTests();

    const second = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops2@example.com",
        tenant_name: "Acme2",
        llm_provider: "mock",
        llm_api_key: "y",
      },
      { token: minted.plaintext_token!, ip: "127.0.0.1" },
    );
    expect(second.status).toBe("failed");
    if (second.status === "failed") expect(second.code).toBe("gone");
  });

  test("invalid token is rejected and audited as denied", async () => {
    await run(tdb.db, { stdout: { write: () => undefined } });
    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      { token: "0".repeat(64), ip: "10.0.0.1" },
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.code).toBe("invalid_token");

    const failed = await tdb.db.select().from(auditLog).where(eq(auditLog.action, "setup.failed"));
    expect(failed.length).toBe(1);
    expect(failed[0]!.result).toBe("denied");
  });

  test("expired token is rejected", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    // Manually rewrite the envelope's expiry into the past.
    const envelope = await _internal.readSetting<{ token_sha256: string; expires_at_ms: number }>(
      tdb.db,
      BOOTSTRAP_TOKEN_KEY,
    );
    await _internal.writeSetting(tdb.db, BOOTSTRAP_TOKEN_KEY, {
      token_sha256: envelope!.token_sha256,
      expires_at_ms: Date.now() - 1_000,
    });

    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      { token: minted.plaintext_token!, ip: "127.0.0.1" },
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.code).toBe("token_expired");
  });

  test("malformed payload returns validation_failed via Zod", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const outcome = await consume(
      tdb.db,
      rbacIds,
      { admin_email: "not-an-email", tenant_name: "", llm_provider: "anthropic", llm_api_key: "" },
      { token: minted.plaintext_token!, ip: "127.0.0.1" },
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.code).toBe("validation_failed");
  });

  test("rate-limit blocks after 5 attempts from the same IP", async () => {
    await run(tdb.db, { stdout: { write: () => undefined } });
    const ip = "203.0.113.7";
    for (let i = 0; i < BOOTSTRAP_MAX_ATTEMPTS; i++) {
      const outcome = await consume(
        tdb.db,
        rbacIds,
        {
          admin_email: "ops@example.com",
          tenant_name: "Acme",
          llm_provider: "mock",
          llm_api_key: "wrong",
        },
        { token: "f".repeat(64), ip },
      );
      // Either invalid_token (most attempts) or one of the gate checks
      // — but never rate_limited within the budget.
      if (outcome.status === "failed") {
        expect(outcome.code).not.toBe("rate_limited");
      }
    }
    const blocked = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      { token: "f".repeat(64), ip },
    );
    expect(blocked.status).toBe("failed");
    if (blocked.status === "failed") expect(blocked.code).toBe("rate_limited");
  });
});

describe("deriveTenantSlug", () => {
  test("lower-cases and dash-collapses", () => {
    expect(deriveTenantSlug("Acme Corp")).toBe("acme-corp");
    expect(deriveTenantSlug("  My  Co!! ")).toBe("my-co");
  });
  test("falls back to subkit on empty/all-symbol input", () => {
    expect(deriveTenantSlug("***")).toBe("subkit");
    expect(deriveTenantSlug("")).toBe("subkit");
  });
  test("caps at 60 chars", () => {
    const long = "x".repeat(80);
    expect(deriveTenantSlug(long).length).toBe(60);
  });
});

describe("buildBootstrapBanner", () => {
  test("includes the literal token + the sk init command + an iso expiry", () => {
    const expires = new Date("2030-01-01T00:00:00.000Z");
    const out = buildBootstrapBanner("abc123", expires);
    expect(out).toContain("sk init --token abc123");
    expect(out).toContain("2030-01-01T00:00:00.000Z");
  });
});
