import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig, ScopeViolationError, setConfigKey } from "../loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";
import { sampleConfigLeaf } from "./leaf-samples.ts";

let dir: string;
let cfgPath: string;
let captured: { module?: string; action?: string; msg?: string; [k: string]: unknown }[];
let restoreStdout: () => void;

function attach(
  buf: { module?: string; action?: string; msg?: string; [k: string]: unknown }[],
): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t));
      } catch {}
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-tenant-strip-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];
  restoreStdout = attach(captured);
  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
  _resetConfigForTests();
});

afterEach(() => {
  restoreStdout();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

const GLOBAL_LEAVES: ConfigLeaf[] = listConfigLeaves().filter(
  (l) => (l.meta.scope ?? "global") === "global",
);
const TENANT_LEAVES: ConfigLeaf[] = listConfigLeaves().filter((l) => l.meta.scope === "tenant");

describe(`tenant overlay strip sweep — ${GLOBAL_LEAVES.length} global leaves, ${TENANT_LEAVES.length} tenant leaves`, () => {
  test("setConfigKey({tenantId, leaf=global-scoped}) throws ScopeViolationError for every global leaf", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const failures: string[] = [];
    for (const [index, leaf] of GLOBAL_LEAVES.entries()) {
      try {
        const probe = sampleConfigLeaf(leaf, index);
        await setConfigKey(leaf.path, probe, {
          tenantId: "tenant-x",
          force: true,
        });
        failures.push(`${dottedPath(leaf)}: setConfigKey did not throw`);
      } catch (err) {
        if (!(err instanceof ScopeViolationError)) {
          failures.push(`${dottedPath(leaf)}: threw ${(err as Error).constructor.name}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("setConfigKey({tenantId, leaf=tenant-scoped}) succeeds for every tenant leaf", async () => {
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const failures: string[] = [];
    let salt = 0;
    for (const leaf of TENANT_LEAVES) {
      const dotted = dottedPath(leaf);
      const value = sampleConfigLeaf(leaf, salt++);
      try {
        await setConfigKey(leaf.path, value, { tenantId: "tenant-y", force: true });
      } catch (err) {
        failures.push(`${dotted}: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("hand-injected non-tenant key in the on-disk overlay is dropped at merge with a warn log", async () => {
    const handCrafted = {
      database: { url: "postgres://x" },
      tenants: {
        "tenant-z": {
          server: { port: 5555 },
          llm: { provider: "anthropic" },
        },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(handCrafted, null, 2));
    captured.length = 0;
    await loadConfig({
      env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
      configPathOverride: cfgPath,
    });
    const { getConfig } = await import("../loader.ts");
    expect(getConfig("tenant-z").server.port).toBe(3000);
    expect(getConfig("tenant-z").llm.provider).toBe("anthropic");
    expect(getConfig().llm.provider).toBe("mock");
  });
});
