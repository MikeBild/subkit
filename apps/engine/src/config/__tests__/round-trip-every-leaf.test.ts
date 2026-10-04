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
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

const PINNED_SCOPES_LEAF = "auth.mcp_oauth.scopes_supported";

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
  const candidates: string[] = [
    tag,
    `https://example.com/${tag.replaceAll("_", "-")}`,
    tag.padEnd(32, "x").slice(0, 32),
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
    case "json": {
      if (dottedPath(leaf) === "tokens.prices")
        return [
          {
            model: "model-sample",
            input_per_mtok: 3,
            output_per_mtok: 15,
            cache_read_per_mtok: 0.3,
            cache_write_per_mtok: 3.75,
          },
        ];
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
    }
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
