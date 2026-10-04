import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DISCOVERY_DIR = join(import.meta.dir);

const DB_STRATEGIES = new Set<string>(["postgres-introspect.ts", "playwright-crawl.ts"]);

const NOT_STRATEGY_RE =
  /(^index\.ts$|\.test\.ts$|\.bak$|^types\.ts$|^service\.ts$|^errors\.ts$|^cache\.ts$|^cache-store\.ts$|^html-to-markdown\.ts$|^processing-postgresql\.ts$|^endpoint-catalog\.ts$|^http-endpoint-collector\.ts$|^postgres-endpoints\.ts$|^postman-import\.ts$|^merge-results\.ts$|^content-classifier\.ts$|^har-import\.ts$|^postman-collection-import\.ts$|^playwright-extract\.ts$|^persistence\.ts$|^index\.test\.ts$)/;

describe("discovery egress guard coverage", () => {
  const files = readdirSync(DISCOVERY_DIR).filter(
    (f) => f.endsWith(".ts") && !NOT_STRATEGY_RE.test(f) && !DB_STRATEGIES.has(f),
  );

  for (const file of files) {
    test(`${file} routes every fetch through assertEgressAllowed`, () => {
      const body = readFileSync(join(DISCOVERY_DIR, file), "utf-8");
      if (!/\bawait fetch\(/.test(body) && !/\bfetch\(/.test(body)) return;
      const hasDelegationOnly =
        /openApiDirectStrategy\.fetch\(/.test(body) && !/\bfetch\(\s*url/.test(body);
      if (hasDelegationOnly) return;
      expect(body).toMatch(/assertEgressAllowed/);
    });
  }
});
