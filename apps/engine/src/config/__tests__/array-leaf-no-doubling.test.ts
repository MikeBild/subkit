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

    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    const afterFirstLoad = [...getConfig().auth.mcp_oauth.scopes_supported];
    expect(afterFirstLoad.slice(0, 3)).toEqual(["mcp:read", "mcp:authoring", "mcp:admin"]);
    expect(afterFirstLoad).toContain(METRICS_SCOPE);

    await setConfigKey(["llm", "model"], "claude-haiku-4-5", { force: true });
    _resetConfigForTests();
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toEqual(afterFirstLoad);

    await setConfigKey(["llm", "model"], "claude-sonnet-4-6", { force: true });
    _resetConfigForTests();
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().auth.mcp_oauth.scopes_supported).toEqual(afterFirstLoad);
  });

  test("the schema default array is applied once, not duplicated", async () => {
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
