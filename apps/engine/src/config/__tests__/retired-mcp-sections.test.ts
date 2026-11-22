import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, ConfigLoaderError, getConfig, loadConfig } from "../loader.ts";

let dir: string;
let cfgPath: string;
const ENV = { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" };

function writeConfig(body: Record<string, unknown>): void {
  writeFileSync(cfgPath, JSON.stringify({ database: { url: ENV.DATABASE_URL }, ...body }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subkit-cfg-retired-mcp-"));
  cfgPath = join(dir, "subkit.config.json");
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("retired mcp config sections", () => {
  test("a leftover mcp.servers array refuses to boot and names the migration", async () => {
    writeConfig({
      mcp: {
        servers: [
          {
            name: "Rovo",
            namespace: "rovo",
            transport: "http",
            url: "https://rovo.example.test/mcp",
          },
        ],
      },
    });

    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    const message = (err as Error).message;
    expect(message).toContain("mcp.servers (1 declaration(s))");
    expect(message).toContain('driver: "mcp"');
    expect(message).toContain("subkit connectors create --file");
    expect(message).toContain(cfgPath);
  });

  test("an EMPTY mcp.servers array boots — there is no declaration to lose", async () => {
    writeConfig({ mcp: { servers: [], read_only: true } });
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect((getConfig().mcp as Record<string, unknown>).servers).toBeUndefined();
    expect(getConfig().mcp.read_only).toBe(true);
  });

  test("an mcp.client that only repeats the new defaults boots", async () => {
    writeConfig({ mcp: { client: { per_server_manifest_byte_cap: 30_000 } } });
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().connectors.mcp.per_server_manifest_byte_cap).toBe(30_000);
  });

  test("an empty mcp.client object boots", async () => {
    writeConfig({ mcp: { client: {} } });
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().connectors.mcp.tools_list_max_pages).toBe(5);
  });

  test("a leftover mcp.client with a REAL override refuses and names the moved key", async () => {
    writeConfig({ mcp: { client: { remote_tool_call_timeout_ms: 45_000 } } });
    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    const message = (err as Error).message;
    expect(message).toContain("mcp.client (remote_tool_call_timeout_ms)");
    expect(message).toContain("connectors.mcp.remote_tool_call_timeout_ms");
  });

  test("an mcp.client key this engine cannot interpret refuses rather than guessing", async () => {
    writeConfig({ mcp: { client: { some_budget_we_dropped: 7 } } });
    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    expect((err as Error).message).toContain("mcp.client (some_budget_we_dropped)");
  });

  test("a tenant overlay is checked too, and the offending tenant is named", async () => {
    writeConfig({
      tenants: {
        "tenant-abc": {
          mcp: {
            servers: [
              { name: "X", namespace: "x", transport: "http", url: "https://x.example.test/mcp" },
            ],
          },
        },
      },
    });
    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    expect((err as Error).message).toContain("tenants.tenant-abc.mcp.servers (1 declaration(s))");
  });

  test("the surviving mcp section (api_key / read_only) still loads, and the budgets live under connectors.mcp", async () => {
    writeConfig({
      mcp: { read_only: true },
      connectors: { mcp: { remote_tool_call_timeout_ms: 45_000 } },
    });
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    expect(getConfig().mcp.read_only).toBe(true);
    expect(getConfig().connectors.mcp.remote_tool_call_timeout_ms).toBe(45_000);
  });
});
