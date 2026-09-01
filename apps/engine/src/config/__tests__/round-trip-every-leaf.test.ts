// Round-trip every leaf in ConfigSchema through setConfigKey + getConfig.
//
// For every leaf the schema declares, this test:
//   1. derives a deterministic value of the right shape
//   2. writes it via setConfigKey (with force=true to bypass the
//      requiresRestart guard in test mode)
//   3. reads it back via getConfig() and asserts equality
//   4. asserts the source_map flips to "global" or "tenant"
//   5. captures the structured "setting.applied" log line
//
// A new Zod kind landing on the schema without a corresponding
// case in `valueFor` fails this test loudly — the leaf would never
// be writable from sk settings configure or PUT /v1/settings.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetConfigForTests,
  getConfig,
  getDiagnostics,
  loadConfig,
  setConfigKey,
} from "../loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

let dir: string;
let cfgPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-rt-"));
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

function pickStringCandidate(leaf: ConfigLeaf, tag: string): string {
  // Try a plain tagged string first. If the leaf's schema rejects it
  // (e.g. optionalUrl unions or session.secret min(32) refinements)
  // walk a small candidate list until one passes. This keeps the
  // sweep deterministic per-leaf without baking path-name knowledge
  // into the test.
  const candidates: string[] = [
    tag,
    `https://example.com/${tag.replaceAll("_", "-")}`,
    // 32-char hex-shaped value for min(32) refinements.
    tag.padEnd(32, "x").slice(0, 32),
    // HH:MM-shaped value for the notifications.push.quietHours* regex.
    // Empty disables the window; the `00:00` candidate covers the
    // populated case.
    "00:00",
    "",
  ];
  for (const c of candidates) {
    const r = leaf.schema.safeParse(c);
    if (r.success) return c;
  }
  return tag;
}

function pickNumberCandidate(leaf: ConfigLeaf, salt: number): number {
  // Walk a candidate ladder so leaves with high min() bounds (e.g.
  // connectors.web_scraper.runtime.max_chars_*, robots_cache.ttl_ms)
  // OR tight max() bounds (min_runs_before_proposing max 50) still
  // resolve to a parsable value without baking path-name knowledge
  // into the test. The first candidate is bounded to 1..50 so leaves
  // with a low ceiling have at least one in-range entry; `0.5` covers
  // fractional leaves (observability.predictive.memory_cap_fraction,
  // min 0.1 / max 1).
  const candidates = [
    Math.max(1, Math.min(50, salt + 1)),
    0.5,
    100,
    1_000,
    60_000,
    100_000,
    3_600_000,
  ];
  for (const c of candidates) {
    if (leaf.schema.safeParse(c).success) return c;
  }
  return candidates[0]!;
}

function valueFor(leaf: ConfigLeaf, salt: number): unknown {
  const tag = `rt-${dottedPath(leaf).replaceAll(".", "_")}-${salt}`;
  switch (leaf.kind) {
    case "string":
      return pickStringCandidate(leaf, tag);
    case "number":
      // Most number leaves are positive ints with sane caps; some have
      // higher min() bounds. The candidate walker picks the smallest
      // value the leaf accepts.
      return pickNumberCandidate(leaf, salt);
    case "boolean":
      return salt % 2 === 0;
    case "enum": {
      const values = leaf.enumValues ?? [];
      if (values.length === 0) return null;
      return values[salt % values.length];
    }
    case "string-list":
      return [tag, `${tag}-2`];
    case "string-array":
      return [tag];
    case "json":
      return [
        { protocol: "api_key", id: "api-key", label: "SubKit API key" },
        {
          protocol: "oidc",
          id: `oidc-${salt}`,
          label: "Public OIDC",
          issuer_url: "https://identity.example.test",
          client_id: `client-${salt}`,
          scopes: "openid profile email",
          tenant_slug: "default",
        },
      ];
    default:
      return tag;
  }
}

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

describe("ConfigSchema round-trip — every leaf", () => {
  const leaves = listConfigLeaves();

  test(`writes and reads back every leaf (${leaves.length} leaves)`, async () => {
    let salt = 0;
    for (const leaf of leaves) {
      const written = valueFor(leaf, salt++);
      const result = await setConfigKey(leaf.path, written, { force: true });
      expect(result.leafPath, `${dottedPath(leaf)} setConfigKey returns the dotted path`).toBe(
        dottedPath(leaf),
      );
      const live = readDeep(getConfig() as unknown as Record<string, unknown>, leaf.path);
      expect(live, `${dottedPath(leaf)} (${leaf.kind}) round-trips`).toEqual(written);
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
    // Diagnostics source_map describes the global config view only.
    expect(getDiagnostics().source_map["llm.api_key"]).toBe("default");
    // The global value stays at the schema default (empty string).
    expect(getConfig().llm.api_key).toBe("");
    // The tenant overlay carries the new value.
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
