import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { llmUsage, tenants, userLlmSettings } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  checkAndDecrement,
  currentMonthBucket,
  monthlyUsage,
  monthlyUsageForUser,
  recordUsage,
  resolveUserMonthlyBudget,
} from "../accounting/index.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let configDir: string;
let tenantId: string;
let otherTenantId: string;

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("user-budget");
  configDir = mkdtempSync(join(tmpdir(), "sk-cfg-user-budget-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "ub-tenant", display_name: "User Budget Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "ub-other", display_name: "User Budget Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
  if (configDir) {
    _resetConfigForTests();
    rmSync(configDir, { recursive: true, force: true });
  }
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(llmUsage);
  await testDb.db.delete(userLlmSettings);
  await setConfigKey("tokens.monthly_budget", 0, { tenantId, force: true });
}, 30_000);

describe.skipIf(skip)("recordUsage — user_id + actor_type round-trip", () => {
  test("records user_id and actor_type=user when provided", async () => {
    await recordUsage(
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 100,
        completion_tokens: 50,
        latency_ms: 10,
        result: "success",
        user_id: USER_A,
        actor_type: "user",
      },
      testDb.db,
    );

    const rows = await testDb.db.select().from(llmUsage).where(eq(llmUsage.tenant_id, tenantId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(USER_A);
    expect(rows[0]?.actor_type).toBe("user");
  });

  test("defaults user_id=null and actor_type=system when omitted", async () => {
    await recordUsage(
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 50,
        completion_tokens: 20,
        latency_ms: 5,
        result: "success",
      },
      testDb.db,
    );

    const rows = await testDb.db.select().from(llmUsage).where(eq(llmUsage.tenant_id, tenantId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.actor_type).toBe("system");
  });

  test("records actor_type=system_account when provided", async () => {
    await recordUsage(
      {
        tenant_id: tenantId,
        flow: "generate",
        model: "mock",
        prompt_tokens: 200,
        completion_tokens: 80,
        latency_ms: 15,
        result: "success",
        user_id: USER_B,
        actor_type: "system_account",
      },
      testDb.db,
    );

    const rows = await testDb.db.select().from(llmUsage).where(eq(llmUsage.tenant_id, tenantId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_type).toBe("system_account");
  });
});

describe.skipIf(skip)("monthlyUsageForUser — per-user sums and isolation", () => {
  test("returns correct token sum for the target user", async () => {
    const bucket = currentMonthBucket();
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: USER_A,
        actor_type: "user",
        month_bucket: bucket,
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 20,
        result: "success",
        user_id: USER_A,
        actor_type: "user",
        month_bucket: bucket,
      },
    ]);

    const usage = await monthlyUsageForUser(tenantId, USER_A, testDb.db);
    expect(usage).toBe(450);
  });

  test("excludes other user's rows", async () => {
    const bucket = currentMonthBucket();
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: USER_A,
        actor_type: "user",
        month_bucket: bucket,
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 30,
        result: "success",
        user_id: USER_B,
        actor_type: "user",
        month_bucket: bucket,
      },
    ]);

    const usageA = await monthlyUsageForUser(tenantId, USER_A, testDb.db);
    const usageB = await monthlyUsageForUser(tenantId, USER_B, testDb.db);
    expect(usageA).toBe(150);
    expect(usageB).toBe(700);
  });

  test("cross-tenant isolation — another tenant's rows for same user_id are not counted", async () => {
    const bucket = currentMonthBucket();
    await testDb.db.insert(llmUsage).values({
      tenant_id: otherTenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 999,
      completion_tokens: 999,
      total_tokens: 1998,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      month_bucket: bucket,
    });

    const usage = await monthlyUsageForUser(tenantId, USER_A, testDb.db);
    expect(usage).toBe(0);
  });

  test("returns 0 when user has no rows in current month", async () => {
    const usage = await monthlyUsageForUser(tenantId, USER_A, testDb.db);
    expect(usage).toBe(0);
  });

  test("does not count a system account with the same UUID as a user", async () => {
    const bucket = currentMonthBucket();
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 100,
        completion_tokens: 0,
        total_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: USER_A,
        actor_type: "user",
        month_bucket: bucket,
      },
      {
        tenant_id: tenantId,
        flow: "converse",
        model: "mock",
        prompt_tokens: 10_000,
        completion_tokens: 0,
        total_tokens: 10_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: USER_A,
        actor_type: "system_account",
        month_bucket: bucket,
      },
    ]);

    expect(await monthlyUsageForUser(tenantId, USER_A, testDb.db)).toBe(100);
  });
});

describe.skipIf(skip)("resolveUserMonthlyBudget — per-user budget reads", () => {
  test("returns the configured budget for a user", async () => {
    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 5000,
    });

    const budget = await resolveUserMonthlyBudget(tenantId, USER_A, testDb.db);
    expect(budget).toBe(5000);
  });

  test("returns null when no per-user budget row exists", async () => {
    const budget = await resolveUserMonthlyBudget(tenantId, USER_A, testDb.db);
    expect(budget).toBeNull();
  });

  test("cross-tenant isolation — another tenant's user_llm_settings row is not returned", async () => {
    await testDb.db.insert(userLlmSettings).values({
      tenant_id: otherTenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 9999,
    });

    const budget = await resolveUserMonthlyBudget(tenantId, USER_A, testDb.db);
    expect(budget).toBeNull();
  });

  test("returns null budget when llm_monthly_token_budget is null", async () => {
    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: null,
    });

    const budget = await resolveUserMonthlyBudget(tenantId, USER_A, testDb.db);
    expect(budget).toBeNull();
  });
});

describe.skipIf(skip)("checkAndDecrement — per-user budget enforcement", () => {
  test("system-account usage with a colliding UUID does not consume the user's cap", async () => {
    const bucket = currentMonthBucket();
    await setConfigKey("tokens.monthly_budget", 100_000, { tenantId, force: true });
    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 500,
    });
    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 1_000,
      completion_tokens: 0,
      total_tokens: 1_000,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 10,
      result: "success",
      user_id: USER_A,
      actor_type: "system_account",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 100, testDb.db, USER_A);

    expect(verdict.ok).toBe(true);
    expect(verdict.scope).toBeUndefined();
    expect(await monthlyUsageForUser(tenantId, USER_A, testDb.db)).toBe(0);
  });

  test("user cap trips with scope=user when user usage exceeds per-user budget", async () => {
    const bucket = currentMonthBucket();

    await setConfigKey("tokens.monthly_budget", 100_000, {
      tenantId,
      force: true,
    });

    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 500,
    });

    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 490,
      completion_tokens: 0,
      total_tokens: 490,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 5,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 20, testDb.db, USER_A);
    expect(verdict.ok).toBe(false);
    expect(verdict.scope).toBe("user");
    expect(verdict.budget).toBe(500);
    expect(verdict.used).toBe(490);
    expect(verdict.remaining).toBe(10);
  });

  test("tenant cap trips with scope=tenant when tenant usage exceeds tenant budget", async () => {
    const bucket = currentMonthBucket();

    await setConfigKey("tokens.monthly_budget", 1000, {
      tenantId,
      force: true,
    });

    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 990,
      completion_tokens: 0,
      total_tokens: 990,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 5,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 20, testDb.db, USER_A);
    expect(verdict.ok).toBe(false);
    expect(verdict.scope).toBe("tenant");
  });

  test("user_id=null — only tenant budget applies", async () => {
    const bucket = currentMonthBucket();

    await setConfigKey("tokens.monthly_budget", 500, {
      tenantId,
      force: true,
    });

    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 490,
      completion_tokens: 0,
      total_tokens: 490,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 5,
      result: "success",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 20, testDb.db, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.scope).toBe("tenant");
  });

  test("tighter-of-two wins — user cap is lower than tenant cap → user cap trips", async () => {
    const bucket = currentMonthBucket();

    await setConfigKey("tokens.monthly_budget", 10_000, {
      tenantId,
      force: true,
    });

    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 200,
    });

    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 195,
      completion_tokens: 0,
      total_tokens: 195,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 5,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 10, testDb.db, USER_A);
    expect(verdict.ok).toBe(false);
    expect(verdict.scope).toBe("user");
    expect(verdict.budget).toBe(200);
  });

  test("ok=true when both tenant and user budgets have headroom", async () => {
    const bucket = currentMonthBucket();

    await setConfigKey("tokens.monthly_budget", 10_000, {
      tenantId,
      force: true,
    });

    await testDb.db.insert(userLlmSettings).values({
      tenant_id: tenantId,
      user_id: USER_A,
      llm_monthly_token_budget: 1_000,
    });

    await testDb.db.insert(llmUsage).values({
      tenant_id: tenantId,
      flow: "converse",
      model: "mock",
      prompt_tokens: 100,
      completion_tokens: 0,
      total_tokens: 100,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 5,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      month_bucket: bucket,
    });

    const verdict = await checkAndDecrement(tenantId, 50, testDb.db, USER_A);
    expect(verdict.ok).toBe(true);
    expect(verdict.scope).toBeUndefined();
  });

  test("unlimited tenant (null budget) with no user budget → always ok", async () => {
    const verdict = await checkAndDecrement(tenantId, 99_999, testDb.db, USER_A);
    expect(verdict.ok).toBe(true);
    expect(verdict.budget).toBeNull();
    expect(verdict.remaining).toBeNull();
    expect(verdict.scope).toBeUndefined();
  });
});

describe.skipIf(skip)("recordUsage — a call the provider did not process is not spend", () => {
  const base = {
    flow: "converse" as const,
    model: "mock",
    latency_ms: 7,
    user_id: USER_A,
    actor_type: "user" as const,
  };

  test("a refusal keeps its row as an error with zero tokens, and moves no budget", async () => {
    const tenantBefore = await monthlyUsage(tenantId, testDb.db);
    const userBefore = await monthlyUsageForUser(tenantId, USER_A, testDb.db);
    for (const result of ["quota_exhausted", "error", "context_too_large"] as const) {
      await recordUsage(
        {
          ...base,
          tenant_id: tenantId,
          prompt_tokens: 15_191,
          completion_tokens: 0,
          cache_read_tokens: 4_000,
          result,
          error: "You have reached your specified API usage limits",
        },
        testDb.db,
      );
    }
    expect(await monthlyUsage(tenantId, testDb.db)).toBe(tenantBefore);
    expect(await monthlyUsageForUser(tenantId, USER_A, testDb.db)).toBe(userBefore);
    const rows = await testDb.db.select().from(llmUsage).where(eq(llmUsage.tenant_id, tenantId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.result).not.toBe("success");
      expect(row.error).toBe("You have reached your specified API usage limits");
      expect(row.prompt_tokens).toBe(0);
      expect(row.cache_read_tokens).toBe(0);
      expect(row.total_tokens).toBe(0);
    }
  });

  test("a failure that produced output was processed and stays billed", async () => {
    await recordUsage(
      {
        ...base,
        tenant_id: tenantId,
        prompt_tokens: 1_000,
        completion_tokens: 40,
        result: "error",
      },
      testDb.db,
    );
    expect(await monthlyUsageForUser(tenantId, USER_A, testDb.db)).toBe(1_040);
  });

  test("a success is recorded as reported", async () => {
    await recordUsage(
      { ...base, tenant_id: tenantId, prompt_tokens: 900, completion_tokens: 0, result: "success" },
      testDb.db,
    );
    expect(await monthlyUsage(tenantId, testDb.db)).toBe(900);
  });
});
