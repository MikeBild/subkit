// Every address the cockpit builds must lead to a page the cockpit has.
//
// Two dead links shipped because nothing checked this. Both were built inside a
// component, both looked right, and both landed on "page not found":
//
//   `/cockpit/runs?…`  handed to a router Link, which already carries /cockpit
//                      as its base — so it became /cockpit/cockpit/runs. That
//                      was the ONLY way out of a failing decision.
//   `/cockpit/runs/<id>` for a run named in a conversation — runs had a list
//                      and no addressable detail page, so every such link
//                      404ed. That address exists now (`/runs/$resourceId` in
//                      route-table.ts); this test is what proves it, because
//                      the same link written before the route would still be
//                      caught here.
//
// The existing route test only checks that NAVIGATION targets are routed. A
// link built in a component was never checked at all, which is exactly where
// both defects lived. This closes the class rather than the two cases.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ROUTE_PATHS } from "./route-table";

const SRC = join(import.meta.dir, "..");
const ROUTES = new Set<string>(ALL_ROUTE_PATHS);

/** The literal paths the cockpit builds, as they appear in source. */
function builtPaths(): { file: string; value: string; router: boolean }[] {
  const out: { file: string; value: string; router: boolean }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const text = readFileSync(full, "utf8");
        // `to="/x"` is router-relative.
        for (const m of text.matchAll(/\bto=\{?"(\/[^"${}]*)"/g))
          out.push({ file: full, value: m[1]!, router: true });
        // ANY `/cockpit/...` string literal, not just one sitting in an href.
        // The first version of this test only read attributes and therefore
        // missed the very defect it was written for: `catalogHref` builds the
        // path inside a helper and returns it. A guard that only sees the
        // shapes you remembered is a guard against the bugs you already found.
        for (const m of text.matchAll(/"(\/cockpit\/[^"${}]*)"/g))
          out.push({ file: full, value: m[1]!, router: false });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Strip the query and reduce `/x/$id` style segments to their route shape. */
function routeOf(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.replace(/\/\$[A-Za-z]+$/, "/$resourceId") || "/";
}

test("a router link never repeats the base path the router already carries", () => {
  const doubled = builtPaths()
    .filter((entry) => entry.router && entry.value.startsWith("/cockpit"))
    .map((entry) => `${entry.file}: to="${entry.value}"`);
  expect(doubled).toEqual([]);
});

test("every address the cockpit builds resolves to one of its pages", () => {
  const dead = builtPaths()
    .map((entry) => ({
      ...entry,
      route: routeOf(entry.router ? entry.value : entry.value.replace(/^\/cockpit/, "") || "/"),
    }))
    .filter((entry) => !ROUTES.has(entry.route))
    .map((entry) => `${entry.file}: ${entry.value} -> ${entry.route}`);
  expect(dead).toEqual([]);
});
