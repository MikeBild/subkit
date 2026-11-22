import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRICS_SCOPE } from "../../auth/scopes.ts";
import {
  _resetConfigForTests,
  getConfig,
  getDiagnostics,
  loadConfig,
  setConfigKey,
} from "../loader.ts";
import { dottedPath } from "../walk.ts";
import { configurationSweepLeaves, sampleConfigLeaf as valueFor } from "./leaf-samples.ts";

const PINNED_SCOPES_LEAF = "auth.mcp_oauth.scopes_supported";

let dir: string;
let cfgPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "subkit-cfg-rt-"));
  cfgPath = join(dir, "subkit.config.json");
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://x", NODE_ENV: "test" },
    configPathOverride: cfgPath,
  });
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

describe("ConfigSchema round-trip — every leaf", () => {
  const leaves = configurationSweepLeaves();

  test(`writes and reads back every leaf (${leaves.length} leaves)`, async () => {
    let salt = 0;
    for (const leaf of leaves) {
      const written = valueFor(leaf, salt++);
      const result = await setConfigKey(leaf.path, written, { force: true });
      expect(result.leafPath, `${dottedPath(leaf)} setConfigKey returns the dotted path`).toBe(
        dottedPath(leaf),
      );
      const live = readDeep(getConfig() as unknown as Record<string, unknown>, leaf.path);
      const label = `${dottedPath(leaf)} (${leaf.kind}) round-trips`;
      if (dottedPath(leaf) === PINNED_SCOPES_LEAF) {
        const applied = live as string[];
        const asked = written as string[];
        expect(applied.slice(0, asked.length), label).toEqual(asked);
        expect(applied, `${label} — pinned scope`).toContain(METRICS_SCOPE);
      } else {
        expect(live, label).toEqual(written);
      }
    }
  });

  test("source_map flips from default to global after setConfigKey", async () => {
    const leaf = leaves.find((l) => dottedPath(l) === "errors.ring_size");
    expect(leaf).toBeDefined();
    expect(getDiagnostics().source_map["errors.ring_size"]).toBe("default");
    await setConfigKey("errors.ring_size", 200, { force: true });
    expect(getDiagnostics().source_map["errors.ring_size"]).toBe("global");
  });

  test("tenant write leaves the global source_map untouched", async () => {
    expect(getDiagnostics().source_map["llm.api_key"]).toBe("default");
    await setConfigKey("llm.api_key", "tenant-only", {
      tenantId: "tenant-x",
      force: true,
    });
    expect(getDiagnostics().source_map["llm.api_key"]).toBe("default");
    expect(getConfig().llm.api_key).toBe("");
    expect(getConfig("tenant-x").llm.api_key).toBe("tenant-only");
  });

  test("requiresRestart leaves flip pending_restart_keys", async () => {
    const restartLeaf = leaves.find((l) => l.meta.requiresRestart && l.kind === "number");
    expect(restartLeaf).toBeDefined();
    await setConfigKey(restartLeaf!.path, valueFor(restartLeaf!, 7), {
      force: true,
    });
    expect(getDiagnostics().pending_restart_keys).toContain(dottedPath(restartLeaf!));
  });
});
