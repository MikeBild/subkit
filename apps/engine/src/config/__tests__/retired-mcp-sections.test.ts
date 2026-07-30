// A config that still declares the retired MCP sections must FAIL boot.
//
// `ConfigSchema` is a plain `z.object`, so an unknown key is stripped at
// parse time with no error and no log — and `setConfigKey` reserializes the
// whole parsed config back to disk, so the first settings write after an
// upgrade would DELETE the operator's server declarations. Silence is not
// an option here: the data would be gone before anyone noticed it was
// ignored. These tests pin the refusal and the message that carries the
// migration.

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

  test("an EMPTY mcp.servers array still refuses — the section is what is gone, not the rows", async () => {
    writeConfig({ mcp: { servers: [] } });
    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    expect((err as Error).message).toContain("mcp.servers (0 declaration(s))");
  });

  test("a leftover mcp.client block refuses and names its connectors.mcp.* replacements", async () => {
    writeConfig({ mcp: { client: { remote_tool_call_timeout_ms: 45_000 } } });
    const err = await loadConfig({ env: ENV, configPathOverride: cfgPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoaderError);
    const message = (err as Error).message;
    expect(message).toContain("mcp.client");
    expect(message).toContain("connectors.mcp.remote_tool_call_timeout_ms");
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
