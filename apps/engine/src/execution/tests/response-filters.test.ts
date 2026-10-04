import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenantDlpRules, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  applyDlpFilters,
  DEFAULT_DLP_RULES,
  loadDlpRules,
  resetDlpCache,
} from "../response-filters.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("dlp_filters");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-dlp", display_name: "DLP" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("applyDlpFilters — path matching", () => {
  test("exact segment match at any depth via **", () => {
    const { value, redacted } = applyDlpFilters(
      { user: { email: "ada@example.test" }, nested: { also: { email: "grace@x.y" } } },
      [{ path_match: "**.email", action: "mask", reason: "pii" }],
    );
    const v = value as { user: { email: string }; nested: { also: { email: string } } };
    expect(v.user.email).toBe("ad****st");
    expect(v.nested.also.email).toBe("gr****.y");
    expect(redacted.map((r) => r.path).sort()).toEqual(["nested.also.email", "user.email"]);
  });

  test("* matches exactly one segment, not arbitrary depth", () => {
    const { redacted } = applyDlpFilters({ a: { secret: "x" }, b: { c: { secret: "y" } } }, [
      { path_match: "*.secret", action: "mask", reason: "pii" },
    ]);
    expect(redacted.map((r) => r.path)).toEqual(["a.secret"]);
  });

  test("regex gate blocks non-matching values", () => {
    const { redacted } = applyDlpFilters({ email: "not-an-email", also: "ada@example.test" }, [
      {
        path_match: "**.email",
        action: "mask",
        reason: "pii",
        pattern_regex: "^[^@]+@[^@]+\\.[^@]{2,}$",
      },
    ]);
    expect(redacted).toEqual([]);
  });
});

describe("applyDlpFilters — action semantics", () => {
  test("mask — short strings go to ****", () => {
    const { value } = applyDlpFilters({ s: "abc" }, [{ path_match: "s", action: "mask" }]);
    expect((value as { s: string }).s).toBe("****");
  });

  test("mask — longer strings show first 2 + last 2", () => {
    const { value } = applyDlpFilters({ s: "secretvalue" }, [{ path_match: "s", action: "mask" }]);
    expect((value as { s: string }).s).toBe("se****ue");
  });

  test("drop — key is removed from output", () => {
    const { value, redacted } = applyDlpFilters({ keep: 1, gone: "secret" }, [
      { path_match: "gone", action: "drop" },
    ]);
    expect(Object.keys(value as object)).toEqual(["keep"]);
    expect(redacted[0]!.action).toBe("drop");
  });

  test("hash — returns sha256:<16 hex>", () => {
    const { value } = applyDlpFilters({ id: "identifier-42" }, [
      { path_match: "id", action: "hash" },
    ]);
    expect((value as { id: string }).id).toMatch(/^sha256:[a-f0-9]{16}$/);
  });

  test("canary PII value never appears in output", () => {
    const CANARY = "canary+ssn@example.com";
    const { value } = applyDlpFilters(
      {
        user: {
          email: CANARY,
          contacts: [{ email: CANARY }, { email: CANARY }],
        },
      },
      [
        {
          path_match: "**.email",
          action: "mask",
          reason: "pii",
          pattern_regex: "^[^@]+@[^@]+\\.[^@]{2,}$",
        },
      ],
    );
    expect(JSON.stringify(value).includes(CANARY)).toBe(false);
  });
});

describe("applyDlpFilters — arrays", () => {
  test("rules apply per array element using numeric segment", () => {
    const { redacted } = applyDlpFilters(
      { users: [{ email: "ada@example.test" }, { email: "grace@example.test" }] },
      [
        {
          path_match: "users.*.email",
          action: "mask",
          reason: "pii",
          pattern_regex: "^[^@]+@[^@]+\\.[^@]{2,}$",
        },
      ],
    );
    expect(redacted.length).toBe(2);
    expect(redacted.map((r) => r.path)).toEqual(["users.0.email", "users.1.email"]);
  });
});

describe("DEFAULT_DLP_RULES — shipped patterns", () => {
  test("covers email / phone / ssn / credit_card", () => {
    const paths = DEFAULT_DLP_RULES.map((r) => r.path_match);
    expect(paths.some((p) => p.endsWith(".email"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".phone"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".ssn"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".credit_card"))).toBe(true);
  });

  test("applied via loadDlpRules to any tenant", async () => {
    resetDlpCache();
    const rules = await loadDlpRules(tenant_id, ctx.db);
    expect(rules.length).toBe(DEFAULT_DLP_RULES.length);
  });
});

describe("loadDlpRules — DB + cache", () => {
  test("adds tenant-specific rule on top of defaults", async () => {
    resetDlpCache();
    await ctx.db.insert(tenantDlpRules).values({
      tenant_id,
      path_match: "**.api_key",
      action: "mask",
      reason: "custom_api_key",
      enabled: true,
    });
    const rules = await loadDlpRules(tenant_id, ctx.db);
    expect(rules.length).toBe(DEFAULT_DLP_RULES.length + 1);
    expect(rules.some((r) => r.path_match === "**.api_key" && r.reason === "custom_api_key")).toBe(
      true,
    );
  });

  test("cache returns the previous ruleset until reset (no DB trip)", async () => {
    resetDlpCache();
    const first = await loadDlpRules(tenant_id, ctx.db);
    await ctx.db.insert(tenantDlpRules).values({
      tenant_id,
      path_match: "**.hidden_from_cache",
      action: "drop",
      reason: "invisible",
      enabled: true,
    });
    const second = await loadDlpRules(tenant_id, ctx.db);
    expect(second.length).toBe(first.length);
    resetDlpCache(tenant_id);
    const third = await loadDlpRules(tenant_id, ctx.db);
    expect(third.length).toBe(first.length + 1);
  });

  test("disabled rules are filtered out", async () => {
    resetDlpCache();
    const [fresh] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-dlp-disabled", display_name: "x" })
      .returning();
    await ctx.db.insert(tenantDlpRules).values({
      tenant_id: fresh!.id,
      path_match: "**.off",
      action: "mask",
      reason: "off",
      enabled: false,
    });
    const rules = await loadDlpRules(fresh!.id, ctx.db);
    expect(rules.some((r) => r.path_match === "**.off")).toBe(false);
  });
});
