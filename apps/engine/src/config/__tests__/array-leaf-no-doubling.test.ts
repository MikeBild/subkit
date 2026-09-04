// Regression: config array leaves must NOT grow across repeated loads /
// write-backs. The original loader fed c12 the same file twice (configFile +
// defaults: fileObj) and c12/defu concatenates arrays, so every load DOUBLED
// every array leaf. `auth.mcp_oauth.scopes_supported` reached 3·2²² ≈ 12.6M
// entries (a 276 MB config) and hung engine boot in production. The merge now
// uses deepMergeReplaceArrays (replace, not concat). These tests pin that.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRICS_SCOPE } from "../../auth/scopes.ts";
import { _resetConfigForTests, getConfig, loadConfig, setConfigKey } from "../loader.ts";
import { ConfigSchema } from "../schema.ts";

let dir: string;
let cfgPath: string;
const ENV = { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-doubling-"));
  cfgPath = join(dir, "subkit.config.json");
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("config loader — array leaves do not double", () => {
  test("scopes_supported stays bounded across load → setConfigKey → reload", async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { url: ENV.DATABASE_URL },
        auth: { mcp_oauth: { scopes_supported: ["mcp:read", "mcp:authoring", "mcp:admin"] } },
      }),
    );

    // The configured three, in the operator's order, plus the one scope an
    // installation may not drop (`config/non-removable-scopes.ts`). The count
    // this test is about is stability across cycles, not the number itself —
    // read it from the first load so adding a non-removable scope is not
    // mistaken for the doubling bug.
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    const afterFirstLoad = [...getConfig().auth.mcp_oauth.scopes_supported];
    expect(afterFirstLoad.slice(0, 3)).toEqual(["mcp:read", "mcp:authoring", "mcp:admin"]);
    expect(afterFirstLoad).toContain(METRICS_SCOPE);

    // A settings write persists the full in-memory config back to disk; a
    // reload must not concatenate the array with itself.
    await setConfigKey(["llm", "model"], "claude-haiku-4-5", { force: true });
    _resetConfigForTests();
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toEqual(afterFirstLoad);

    // Third cycle — still bounded.
    await setConfigKey(["llm", "model"], "claude-sonnet-4-6", { force: true });
    _resetConfigForTests();
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toEqual(afterFirstLoad);
  });

  test("the schema default array is applied once, not duplicated", async () => {
    // No mcp_oauth in the file → the schema default applies; a load must yield
    // exactly the default set, and a reload after a write must keep it. Read
    // the length from the schema rather than typing it, so adding an offerable
    // scope (e.g. `metrics:read`) does not look like a doubling regression.
    const DEFAULT_LENGTH = ConfigSchema.parse({
      database: { url: ENV.DATABASE_URL },
    }).auth.mcp_oauth.scopes_supported.length;
    writeFileSync(cfgPath, JSON.stringify({ database: { url: ENV.DATABASE_URL } }));

    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toHaveLength(DEFAULT_LENGTH);

    await setConfigKey(["llm", "model"], "claude-haiku-4-5", { force: true });
    _resetConfigForTests();
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toHaveLength(DEFAULT_LENGTH);
  });
});
