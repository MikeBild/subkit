// Egress-guard coverage for the discovery surface.
//
// Source-level invariant: every discovery strategy that issues an
// HTTP fetch MUST first call `assertEgressAllowed(url)` so that
// SSRF attempts via spec URLs (private ranges, localhost,
// link-local) get the same RFC1918 reject as runtime drivers. This
// test pins the coverage so a new strategy can't slip in unguarded.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const DISCOVERY_DIR = join(import.meta.dir);

// Strategies whose `fetch(url, ...)` calls a database / DSN, not an
// HTTP endpoint — they don't need the egress guard.
// `playwright-crawl.ts` drives Chromium's `page.goto(...)`, not Node's
// `fetch()` — its network egress is governed by the Chromium process
// boundary, not the Node assertEgressAllowed() guard. Tracked
// separately if/when Chromium gains an SSRF surface in subkit.
const DB_STRATEGIES = new Set<string>(["postgres-introspect.ts", "playwright-crawl.ts"]);

// Files that aren't strategies (entrypoints, helpers, types, tests).
const NOT_STRATEGY_RE =
  /(^index\.ts$|\.test\.ts$|\.bak$|^types\.ts$|^service\.ts$|^errors\.ts$|^cache\.ts$|^cache-store\.ts$|^html-to-markdown\.ts$|^processing-postgresql\.ts$|^endpoint-catalog\.ts$|^http-endpoint-collector\.ts$|^postgres-endpoints\.ts$|^postman-import\.ts$|^merge-results\.ts$|^content-classifier\.ts$|^har-import\.ts$|^postman-collection-import\.ts$|^playwright-extract\.ts$|^persistence\.ts$|^index\.test\.ts$)/;

describe("discovery egress guard coverage", () => {
  const files = readdirSync(DISCOVERY_DIR).filter(
    (f) => f.endsWith(".ts") && !NOT_STRATEGY_RE.test(f) && !DB_STRATEGIES.has(f),
  );

  for (const file of files) {
    test(`${file} routes every fetch through assertEgressAllowed`, () => {
      const body = readFileSync(join(DISCOVERY_DIR, file), "utf-8");
      // Skip files that don't actually issue HTTP fetches.
      if (!/\bawait fetch\(/.test(body) && !/\bfetch\(/.test(body)) return;
      // Helper modules that wrap a single delegated `openApiDirectStrategy.fetch(...)`
      // inherit the guard from the inner strategy — recognise the
      // delegation pattern so the test doesn't false-positive.
      const hasDelegationOnly =
        /openApiDirectStrategy\.fetch\(/.test(body) && !/\bfetch\(\s*url/.test(body);
      if (hasDelegationOnly) return;
      expect(body).toMatch(/assertEgressAllowed/);
    });
  }
});
