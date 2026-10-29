import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../db/schema/audit.ts";
import { engineSettings, tenants } from "../db/schema/identity.ts";
import { runtimeSecretVersions, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { type SeededRoleIds, seedBuiltinRolesAndPermissions } from "../rbac/seed.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { DEMO_WORKFLOWS } from "./demo-seed.ts";

const clearCache = (): void => {};

const acceptingProbe = async () => ({ ok: true as const, model: "probe-model" });
const refusingProbe = async () => ({
  ok: false as const,
  model: "probe-model",
  reason: "anthropic rejected the API key (HTTP 401)",
});

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
  LLM_UNREACHABLE_HINT,
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
    expect(envelope!.expires_at_ms - getTestNow()).toBeGreaterThan(BOOTSTRAP_TOKEN_TTL_MS - 5_000);
    expect(envelope!.expires_at_ms - getTestNow()).toBeLessThanOrEqual(BOOTSTRAP_TOKEN_TTL_MS);
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

describe("consume() — starter workflows", () => {
  test("a completed setup leaves the tenant with something it can actually run", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Starter Org",
        llm_provider: "mock",
        llm_api_key: "mock-local-no-external-account",
      },
      { token: minted.plaintext_token! },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    const rows = await tdb.db
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(eq(workflows.tenant_id, outcome.tenant_id));
    const slugs = rows.map((r) => r.slug);
    for (const spec of DEMO_WORKFLOWS) expect(slugs).toContain(spec.slug);
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
      { token, ip: "127.0.0.1", user_agent: "sk/test", probe: acceptingProbe },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.tenant_id).toBeDefined();
    expect(outcome.api_key_plaintext).toMatch(/^wf_live_/);

    const tenantRows = await tdb.db.select().from(tenants);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.display_name).toBe("Acme Corp");
    expect(tenantRows[0]!.slug).toBe("acme-corp");
    expect(tenantRows[0]!.is_operator).toBe(true);

    const sentinel = await _internal.readSetting<boolean>(tdb.db, BOOTSTRAP_COMPLETED_KEY);
    expect(sentinel).toBe(true);
    const envelope = await _internal.readSetting(tdb.db, BOOTSTRAP_TOKEN_KEY);
    expect(envelope).toBeUndefined();

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

  test("expired token is rejected, a fresh token is re-minted, and the new token redeems", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const envelope = await _internal.readSetting<{ token_sha256: string; expires_at_ms: number }>(
      tdb.db,
      BOOTSTRAP_TOKEN_KEY,
    );
    await _internal.writeSetting(tdb.db, BOOTSTRAP_TOKEN_KEY, {
      token_sha256: envelope!.token_sha256,
      expires_at_ms: getTestNow() - 1_000,
    });

    const captured: string[] = [];
    const outcome = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      {
        token: minted.plaintext_token!,
        ip: "127.0.0.1",
        stdout: { write: (c) => captured.push(c) },
      },
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.code).toBe("token_expired");
      expect(outcome.hint).toContain("fresh token");
    }

    const reminted = await _internal.readSetting<{ token_sha256: string; expires_at_ms: number }>(
      tdb.db,
      BOOTSTRAP_TOKEN_KEY,
    );
    expect(reminted).toBeDefined();
    expect(reminted!.token_sha256).not.toBe(envelope!.token_sha256);
    expect(reminted!.expires_at_ms).toBeGreaterThan(getTestNow());
    const banner = captured.join("");
    expect(banner).toContain("sk init --token");
    const tokenMatch = /sk init --token ([0-9a-f]{64})/.exec(banner);
    expect(tokenMatch).not.toBeNull();

    const retry = await consume(
      tdb.db,
      rbacIds,
      {
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      },
      { token: tokenMatch![1]!, ip: "127.0.0.1" },
    );
    expect(retry.status).toBe("ok");
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
    expect(out).toContain("docker exec <container> sk init --token abc123");
    expect(out).toContain("--admin-email");
    expect(out).toContain("engine --issue-admin-key --tenant <slug>");
  });
});

describe("consume() — the LLM key is checked live before anything is saved", () => {
  const payload = {
    admin_email: "ops@example.com",
    tenant_name: "Acme Corp",
    llm_provider: "anthropic" as const,
    llm_api_key: "sk-ant-wrong",
  };

  test("a refused key answers llm_unreachable and leaves no tenant, no secret and no sentinel", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const secretsBefore = (await tdb.db.select().from(runtimeSecretVersions)).length;
    const outcome = await consume(tdb.db, rbacIds, payload, {
      token: minted.plaintext_token!,
      probe: refusingProbe,
    });
    expect(outcome).toEqual({
      status: "failed",
      code: "llm_unreachable",
      message: "the LLM access check failed: anthropic rejected the API key (HTTP 401)",
      hint: LLM_UNREACHABLE_HINT,
    });
    expect(await tdb.db.select().from(tenants)).toHaveLength(0);
    expect(await tdb.db.select().from(runtimeSecretVersions)).toHaveLength(secretsBefore);
    expect(await _internal.readSetting(tdb.db, BOOTSTRAP_COMPLETED_KEY)).toBeUndefined();
    expect(await _internal.readSetting(tdb.db, BOOTSTRAP_TOKEN_KEY)).toBeDefined();
    const failed = await tdb.db.select().from(auditLog).where(eq(auditLog.action, "setup.failed"));
    expect(failed.map((row) => (row.metadata as { code?: string }).code)).toEqual([
      "llm_unreachable",
    ]);
    expect(JSON.stringify(failed)).not.toContain("sk-ant-wrong");
  });

  test("the same token works once the key is accepted", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const token = minted.plaintext_token!;
    await consume(tdb.db, rbacIds, payload, { token, probe: refusingProbe });
    const outcome = await consume(tdb.db, rbacIds, payload, { token, probe: acceptingProbe });
    expect(outcome.status).toBe("ok");
    expect(await tdb.db.select().from(tenants)).toHaveLength(1);
  });

  test("the probe sees the provider and key that would be saved", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const seen: unknown[] = [];
    await consume(tdb.db, rbacIds, payload, {
      token: minted.plaintext_token!,
      probe: async (p) => {
        seen.push(p);
        return { ok: true, model: null };
      },
    });
    expect(seen).toEqual([{ provider: "anthropic", api_key: "sk-ant-wrong" }]);
  });

  test("a model passed to the first start reaches the probe", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const seen: unknown[] = [];
    await consume(
      tdb.db,
      rbacIds,
      { ...payload, llm_provider: "azure", llm_model: "prod-deployment" },
      {
        token: minted.plaintext_token!,
        probe: async (p) => {
          seen.push(p);
          return { ok: true, model: p.model ?? null };
        },
      },
    );
    expect(seen).toEqual([
      { provider: "azure", api_key: "sk-ant-wrong", model: "prod-deployment" },
    ]);
  });

  test("the mock provider passes without a probe call", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const outcome = await consume(
      tdb.db,
      rbacIds,
      { ...payload, llm_provider: "mock" },
      { token: minted.plaintext_token! },
    );
    expect(outcome.status).toBe("ok");
  });
});

describe("consume() — one first start at a time", () => {
  test("a second attempt while the first is checking its key gets in_progress and seeds nothing", async () => {
    const minted = await run(tdb.db, { stdout: { write: () => undefined } });
    const token = minted.plaintext_token!;
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const payload = {
      admin_email: "ops@example.com",
      tenant_name: "Acme Corp",
      llm_provider: "anthropic" as const,
      llm_api_key: "sk-ant-key",
    };
    const first = consume(tdb.db, rbacIds, payload, {
      token,
      ip: "10.0.0.1",
      probe: async () => {
        entered();
        await held;
        return { ok: true, model: null };
      },
    });
    await probing;
    const second = await consume(tdb.db, rbacIds, payload, {
      token,
      ip: "10.0.0.2",
      probe: acceptingProbe,
    });
    expect(second).toEqual(expect.objectContaining({ status: "failed", code: "in_progress" }));
    expect(await tdb.db.select().from(tenants)).toHaveLength(0);
    release();
    expect((await first).status).toBe("ok");
    expect(await tdb.db.select().from(tenants)).toHaveLength(1);
    const third = await consume(tdb.db, rbacIds, payload, {
      token,
      ip: "10.0.0.3",
      probe: acceptingProbe,
    });
    expect(third).toEqual(expect.objectContaining({ status: "failed", code: "gone" }));
  });
});
