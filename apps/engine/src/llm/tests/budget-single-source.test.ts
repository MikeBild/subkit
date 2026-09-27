// The monthly token cap has exactly one home.
//
// It had three. `tenant_llm_settings.llm_monthly_token_budget` and the legacy
// `tenants.llm_monthly_token_budget` were read by the enforcement path and
// written by nothing in the product — setting the cap that returns 429 meant
// hand-editing an internal table. Meanwhile `tokens.monthly_budget`, declared
// in the config schema as "Hard cap on tokens consumed per calendar month",
// editable in the settings surface, revisioned and audited, was read by
// nobody. So an operator could set a cap that never bit, and could not see
// the one that did.
//
// Two assertions, and they guard different halves. The first is behavioural:
// the value an operator writes is the value the enforcement reads. The second
// is structural: no second column may quietly come back, because the first
// test would still pass while a reader drifted onto the new column.

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
    // `0` is the shipped default. Read as a literal cap it would refuse every
    // call on a fresh installation.
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
    // Paths that run before boot completes must not be refused for want of a
    // cap nobody set. Unreadable config is "no cap", the same answer an
    // unconfigured tenant gets.
    _resetConfigForTests();
    expect(resolveMonthlyBudget(TENANT)).toBeNull();
  });

  test("has no second home at tenant level in the database schema", () => {
    // The structural half. Read from source because a type error is not the
    // failure mode being guarded against: a reintroduced column with its own
    // new reader would compile and pass every behavioural test above while
    // the two caps drifted apart again.
    //
    // `user_llm_settings` keeps its own per-user ceiling. That is a different
    // cap at a different scope, and the config system has no per-user scope to
    // hold it — so it stays a column and is deliberately not forbidden here.
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
    // The per-user ceiling is expected to still be there; if it ever goes, the
    // per-user enforcement below it has lost its source and this should say so.
    expect(
      declares(llm, "userLlmSettings"),
      "`user_llm_settings` lost the per-user cap its resolver reads",
    ).toBe(true);
  });
});
