// Pin two RBAC catalog invariants that pre-this-test relied on
// runtime discovery (a 403 in CI for a route, or a stale recipe
// prerequisite). Both fail at PR time instead of at first call:
//
//   1. Every `requirePermission("slug", ...)` site in the HTTP
//      route surface must reference a slug that exists in
//      `apps/engine/src/rbac/permissions.json`. Without this, a
//      bearer-auth caller of the route gets a permanent 403 because
//      no role can grant a permission that isn't in the catalog —
//      the actual #147 review S-4 finding for `execution:signal`.
//
//   2. Every connector-recipe `prerequisites` entry that names a
//      permission slug (`<noun>:<verb>` shape) must reference a
//      catalog slug. Recipes ship as documentation; if a permission
//      is renamed and a recipe's prose isn't updated, the next
//      operator following the recipe sees a 403 they can't resolve
//      from the recipe alone.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { ALL_PERMISSION_NAMES } from "../catalog.ts";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
// Permission slugs follow `<noun>:<verb>` — the catalog enforces this
// implicitly via existing entries; this regex is the same shape the
// RBAC evaluator parses at runtime.
const PERMISSION_TOKEN = /\b([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)\b/g;

const catalog = new Set<string>(ALL_PERMISSION_NAMES);

describe("RBAC permission catalog coverage", () => {
  test("every catalog entry has a permission name", () => {
    expect(catalog.size).toBeGreaterThan(0);
  });

  test('every requirePermission("slug", ...) site references a known catalog slug', async () => {
    // Walk the HTTP route surface for `requirePermission("...")`
    // calls; pull the slug literal; assert membership.
    const glob = new Glob("apps/engine/src/http/routes/**/*.ts");
    const callRe = /requirePermission\(\s*["']([^"']+)["']/g;
    const offenders: Array<{ file: string; slug: string }> = [];
    for await (const file of glob.scan({ cwd: ROOT, absolute: false, onlyFiles: true })) {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      callRe.lastIndex = 0;
      for (const m of src.matchAll(callRe)) {
        const slug = m[1] ?? "";
        if (!catalog.has(slug)) offenders.push({ file, slug });
      }
    }
    if (offenders.length > 0) {
      const lines = offenders.map((o) => `  ${o.file}: requirePermission("${o.slug}")`).join("\n");
      throw new Error(
        `requirePermission slug not in apps/engine/src/rbac/permissions.json:\n${lines}\n\nAdd the entry or fix the slug.`,
      );
    }
  });

  test("execution:signal is in the catalog (#147 review S-4 + recipe prerequisite)", () => {
    // Surface the specific finding from PR #147 / review S-4 directly
    // — the `merge-pr-after-approval` recipe's prose names this slug,
    // and the signals route gates bearer auth on it. Pre-fix the slug
    // was missing from the catalog so any non-HMAC caller saw 403.
    expect(catalog.has("execution:signal")).toBe(true);
  });

  test("recipe prerequisites only cite permission slugs that exist in the catalog", () => {
    const templates = loadBuiltinTemplates();
    const offenders: Array<{ template: string; recipe: string; slug: string }> = [];
    for (const t of templates) {
      for (const r of t.recipes) {
        for (const prereq of r.prerequisites ?? []) {
          PERMISSION_TOKEN.lastIndex = 0;
          for (const m of prereq.matchAll(PERMISSION_TOKEN)) {
            const slug = m[0];
            // Skip non-permission `noun:verb` patterns recipes may
            // legitimately mention (URL paths, tags, etc.). The
            // catalog membership check is the real gate.
            if (catalog.has(slug)) continue;
            // Only flag tokens that look like permissions: the
            // `noun` is a known resource type from the catalog.
            const noun = slug.split(":")[0];
            const isResourceNoun = [...catalog].some((p) => p.startsWith(`${noun}:`));
            if (isResourceNoun) {
              offenders.push({ template: t.slug, recipe: r.slug, slug });
            }
          }
        }
      }
    }
    if (offenders.length > 0) {
      const lines = offenders
        .map((o) => `  ${o.template}.${o.recipe}: cites "${o.slug}"`)
        .join("\n");
      throw new Error(
        `connector-recipe prerequisites cite a permission-shaped slug that's not in the catalog:\n${lines}\n\nUpdate the catalog or rewrite the prose.`,
      );
    }
  });
});
