import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { resolveMonthlyBudget } from "../accounting/index.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";

async function withConfig(run: () => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-budget-source-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
  try {
    await run();
  } finally {
    _resetConfigForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the monthly token cap", () => {
  test("is read from the leaf an operator can write", async () => {
    await withConfig(async () => {
      await setConfigKey("tokens.monthly_budget", 4242, { tenantId: TENANT, force: true });
      expect(resolveMonthlyBudget(TENANT)).toBe(4242);
    });
  });

  test("treats the schema default as unlimited, not as a cap of zero", async () => {
    await withConfig(async () => {
      expect(resolveMonthlyBudget(TENANT)).toBeNull();
      await setConfigKey("tokens.monthly_budget", 0, { tenantId: TENANT, force: true });
      expect(resolveMonthlyBudget(TENANT)).toBeNull();
    });
  });

  test("belongs to one tenant at a time", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    await withConfig(async () => {
      await setConfigKey("tokens.monthly_budget", 900, { tenantId: TENANT, force: true });
      expect(resolveMonthlyBudget(TENANT)).toBe(900);
      expect(resolveMonthlyBudget(other)).toBeNull();
    });
  });

  test("answers without a cap when config was never loaded", async () => {
    _resetConfigForTests();
    expect(resolveMonthlyBudget(TENANT)).toBeNull();
  });

  test("has no second home at tenant level in the database schema", () => {
    const schemaDir = join(import.meta.dir, "..", "..", "db", "schema");
    const declares = (source: string, table: string): boolean => {
      const start = source.indexOf(`export const ${table} = pgTable(`);
      if (start === -1) throw new Error(`table ${table} not found`);
      const next = source.indexOf("export const ", start + 1);
      const block = source.slice(start, next === -1 ? undefined : next);
      return block
        .split("\n")
        .some(
          (line) =>
            line.includes('"llm_monthly_token_budget"') && !line.trimStart().startsWith("//"),
        );
    };

    const identity = readFileSync(join(schemaDir, "identity.ts"), "utf8");
    const llm = readFileSync(join(schemaDir, "llm.ts"), "utf8");

    expect(declares(identity, "tenants"), "`tenants` declares a monthly cap column again").toBe(
      false,
    );
    expect(
      declares(llm, "tenantLlmSettings"),
      "`tenant_llm_settings` declares a monthly cap column again",
    ).toBe(false);
    expect(
      declares(llm, "userLlmSettings"),
      "`user_llm_settings` lost the per-user cap its resolver reads",
    ).toBe(true);
  });
});
