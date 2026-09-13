// A config that still declares the retired MCP sections WITH SOMETHING IN THEM
// must FAIL boot — and one that declares them empty must not.
//
// `ConfigSchema` is a plain `z.object`, so an unknown key is stripped at
// parse time with no error and no log — and `setConfigKey` reserializes the
// whole parsed config back to disk, so the first settings write after an
// upgrade would DELETE the operator's server declarations. Silence is not
// an option here: the data would be gone before anyone noticed it was
// ignored.
//
// That argument is about data, and it stops where the data stops. An empty
// `servers` array and an `mcp.client` that only repeats the new defaults hold
// no decision anyone made, so there is nothing for a later write to erase —
// and refusing over them stopped a production deploy for nothing. These tests
// pin both halves: the refusal where something is at stake, the boot where
// nothing is.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetConfigForTests, ConfigLoaderError, getConfig, loadConfig } from "../loader.ts";

let dir: string;
let cfgPath: string;
const ENV = { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" };

function writeConfig(body: Record<string, unknown>): void {
  writeFileSync(cfgPath, JSON.stringify({ database: { url: ENV.DATABASE_URL }, ...body }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-retired-mcp-"));
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
    // The offending path AND how many declarations are at stake — an
    // operator has to know whether one server or twelve are about to be
    // ignored.
    expect(message).toContain("mcp.servers (1 declaration(s))");
    // The migration, not just the complaint.
    expect(message).toContain('driver: "mcp"');
    expect(message).toContain("sk connectors create --file");
    // The config path, so the operator knows which file to edit when
    // several profiles are in play.
    expect(message).toContain(cfgPath);
  });

  // The refusal protects DATA, so it may not reach further than the data does.
  // These three are the empty cases: they cost a production deploy — the engine
  // refused to boot five times over a message that itself printed
  // "(0 declaration(s))", and the rollback that followed took the service down.
  test("an EMPTY mcp.servers array boots — there is no declaration to lose", async () => {
    writeConfig({ mcp: { servers: [], read_only: true } });
    await loadConfig({ env: ENV, configPathOverride: cfgPath });
    // The retired key is gone from the parsed config and the surviving
    // neighbour in the same section is untouched.
    expect((getConfig().mcp as Record<string, unknown>).servers).toBeUndefined();
    expect(getConfig().mcp.read_only).toBe(true);
  });

  test("an mcp.client that only repeats the new defaults boots", async () => {
    // Exactly what production carried: the two budgets at their default values,
    // which `connectors.mcp` now defaults to anyway.
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
    // Which key is at stake, not just which section — the operator has to know
    // what to carry over.
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
    // The inbound MCP section is a different concern and is untouched.
    expect(getConfig().mcp.read_only).toBe(true);
    expect(getConfig().connectors.mcp.remote_tool_call_timeout_ms).toBe(45_000);
  });
});
