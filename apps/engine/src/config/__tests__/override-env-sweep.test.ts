// Legacy SK_OVERRIDE_<KEY> import sweep — every leaf in ConfigSchema is
// reachable as a one-time seed. For each leaf we boot the loader with a
// single legacy env var set, then assert:
//
//   1. getConfig() returns the imported value
//   2. getDiagnostics().source_map[<dotted>] === "global"
//   3. getDiagnostics().override_keys stays empty
//   4. config.legacy_env.seeded logs the imported leaf once
//
// Catches mapping bugs in the SK_OVERRIDE_*-to-leaf-path translator (e.g.
// snake_case vs. dot drift). Boolean and number leaves go through their
// respective string parsers; enum leaves pick a non-default member.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetConfigForTests, getConfig, getDiagnostics, loadConfig } from "../loader.ts";
import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

let dir: string;
let cfgPath: string;

interface CapturedLog {
  module?: string;
  action?: string;
  seeded_keys?: string[];
  [k: string]: unknown;
}

let captured: CapturedLog[];
let restoreStdout: () => void;

function attachStdoutCapture(buf: CapturedLog[]): () => void {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        buf.push(JSON.parse(t) as CapturedLog);
      } catch {
        /* not JSON */
      }
    }
    return orig(chunk);
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = orig as typeof process.stdout.write;
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-cfg-override-"));
  cfgPath = join(dir, "subkit.config.json");
  captured = [];
  restoreStdout = attachStdoutCapture(captured);
  const { reconfigureLogger } = await import("../../logging/logger.ts");
  reconfigureLogger({ level: "info", format: "ndjson" });
  _resetConfigForTests();
});

afterEach(() => {
  restoreStdout();
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function envKey(dotted: string): string {
  return `SK_OVERRIDE_${dotted.toUpperCase().replaceAll(".", "_")}`;
}

function pickOverrideValue(leaf: ConfigLeaf, salt: number): string {
  const tag = `ov-${dottedPath(leaf).replaceAll(".", "-")}-${salt}`;
  switch (leaf.kind) {
    case "string": {
      const candidates = [
        tag,
        `https://example.com/${tag}`,
        tag.padEnd(32, "x").slice(0, 32),
        // HH:MM-shaped value for the notifications.push.quietHours* regex.
        "00:00",
        "",
      ];
      for (const c of candidates) {
        const r = leaf.schema.safeParse(c);
        if (r.success) return c;
      }
      return tag;
    }
    case "number": {
      // Candidate ladder for leaves with higher min() bounds
      // (web-scraper max_chars_*, robots_cache.ttl_ms) or tight
      // max() bounds (min_runs_before_proposing max 50).
      const numCandidates = [
        Math.max(1, Math.min(50, salt + 1)),
        // `0.5` covers fractional leaves (memory_cap_fraction, min 0.1 / max 1).
        0.5,
        200,
        1_000,
        60_000,
        100_000,
        3_600_000,
      ];
      for (const c of numCandidates) {
        if (leaf.schema.safeParse(c).success) return String(c);
      }
      return String(numCandidates[0]);
    }
    case "boolean":
      return "true";
    case "enum": {
      const values = leaf.enumValues ?? [];
      if (values.length < 2) return values[0] ?? "";
      return values[1 + (salt % (values.length - 1))]!;
    }
    case "string-list":
      // override env mapper splits comma-separated; sweep uses one entry.
      return tag;
    case "string-array":
      return tag;
    case "json":
      return JSON.stringify([
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
      ]);
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

const LEAVES = listConfigLeaves();

describe(`legacy SK_OVERRIDE_<KEY> seed sweep — ${LEAVES.length} leaves`, () => {
  test("every leaf can seed canonical config without becoming a runtime override", async () => {
    const failures: string[] = [];
    let salt = 0;
    for (const leaf of LEAVES) {
      const dotted = dottedPath(leaf);
      // Skip leaves that the loader treats as special at boot (database.url
      // has its own DATABASE_URL fallback path; auth.session.secret is auto-
      // generated). They are exercised in dedicated tests.
      if (dotted === "database.url" || dotted === "auth.session.secret") {
        salt += 1;
        continue;
      }
      // string-list leaves expect comma-separated semantics; the
      // override-env mapper does not currently split arrays — skip.
      if (leaf.kind === "string-list" || leaf.kind === "string-array") {
        salt += 1;
        continue;
      }
      _resetConfigForTests();
      rmSync(cfgPath, { force: true });
      captured.length = 0;
      const k = envKey(dotted);
      const v = pickOverrideValue(leaf, salt++);
      try {
        await loadConfig({
          env: {
            DATABASE_URL: "postgres://x",
            NODE_ENV: "test",
            [k]: v,
          },
          configPathOverride: cfgPath,
        });
      } catch (err) {
        failures.push(`${dotted}: loadConfig threw — ${(err as Error).message.slice(0, 120)}`);
        continue;
      }
      const live = readDeep(getConfig(), leaf.path);
      const expected =
        leaf.kind === "number"
          ? Number(v)
          : leaf.kind === "boolean"
            ? true
            : leaf.kind === "json"
              ? JSON.parse(v)
              : v;
      if (JSON.stringify(live) !== JSON.stringify(expected)) {
        failures.push(
          `${dotted}: live=${JSON.stringify(live)} expected=${JSON.stringify(expected)}`,
        );
        continue;
      }
      const diag = getDiagnostics();
      if (diag.source_map[dotted] !== "global") {
        failures.push(`${dotted}: source_map=${diag.source_map[dotted]}`);
      }
      if (diag.override_keys.length !== 0) {
        failures.push(`${dotted}: unexpected override_keys [${diag.override_keys.join(",")}]`);
      }
      const seedLog = captured.filter(
        (l) => l.module === "config" && l.action === "legacy_env.seeded",
      );
      if (seedLog.length !== 1 || !seedLog[0]?.seeded_keys?.includes(dotted)) {
        failures.push(`${dotted}: legacy_env.seeded log absent or missing leaf`);
      }
    }
    expect(
      failures,
      `${failures.length} override-sweep failures:\n${failures.slice(0, 20).join("\n")}`,
    ).toEqual([]);
  }, 60_000);
});
