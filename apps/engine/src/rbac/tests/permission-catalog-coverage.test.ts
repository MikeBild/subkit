// Pin RBAC catalog invariants that pre-this-test relied on runtime
// discovery (a 403 in CI for a route, or a stale recipe prerequisite).
// They fail at PR time instead of at first call:
//
//   1. Every literal-string `requirePermission("slug", ...)` site in
//      the HTTP route surface must reference a slug that exists in
//      `apps/engine/src/rbac/permissions.json`. Without this, a
//      bearer-auth caller of the route gets a permanent 403 because
//      no role can grant a permission that isn't in the catalog —
//      the actual #147 review S-4 finding for `execution:signal`.
//
//   2. NO `requirePermission(...)` call site uses a non-literal first
//      arg. Dynamic slugs would silently bypass invariant #1; an
//      explicit gate keeps the catalog-coverage check honest.
//
//   3. Every connector-recipe `prerequisites` entry that names a
//      permission slug (`<noun>:<verb>` shape) must reference a
//      catalog slug. Recipes ship as documentation; if a permission
//      is renamed and a recipe's prose isn't updated, the next
//      operator following the recipe sees a 403 they can't resolve
//      from the recipe alone.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Glob } from "bun";
import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { ALL_PERMISSION_NAMES } from "../catalog.ts";

// Walk upward from this file until we find the repo root marker
// (`package.json` whose `name` is `subkit`). `SUBKIT_REPO_ROOT` env
// override is honoured first so a CI runner with a non-standard layout
// can pin it explicitly. Per #147 review W-5 — the previous
// hard-coded `../../../../..` traversal silently globbed the wrong
// files if the test ever moved.
function resolveRepoRoot(): string {
  const fromEnv = process.env.SUBKIT_REPO_ROOT;
  if (fromEnv && existsSync(resolve(fromEnv, "package.json"))) return fromEnv;
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "subkit") return dir;
      } catch {
        // not parseable — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `permission-catalog-coverage: failed to locate the subkit repo root. Set SUBKIT_REPO_ROOT or run from inside the repo.`,
  );
}

const ROOT = resolveRepoRoot();

// Permission slugs follow `<noun>:<verb>` — the catalog enforces this
// implicitly via existing entries; this regex is the same shape the
// RBAC evaluator parses at runtime.
const PERMISSION_TOKEN = /\b([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)\b/g;

const catalog = new Set<string>(ALL_PERMISSION_NAMES);

describe("RBAC permission catalog coverage", () => {
  test("every catalog entry has a permission name", () => {
    expect(catalog.size).toBeGreaterThan(0);
  });

  test('every literal `requirePermission("slug", ...)` site references a known catalog slug', async () => {
    // Walk the HTTP route surface for `requirePermission("…")` calls
    // with a literal first argument; assert catalog membership.
    // Non-literal calls are caught by the next test below.
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

  test("no `requirePermission(...)` site uses a non-literal first argument", async () => {
    // The literal-string check above is only honest if every call
    // site actually has a literal. A dynamic slug
    // (`requirePermission(mySlug, ...)`) would silently bypass the
    // catalog-coverage gate, defeating the purpose of #147 review S-4.
    // If a future feature legitimately needs a dynamic slug, add it
    // to the explicit `DYNAMIC_ALLOW` set with a comment naming the
    // RBAC reasoning.
    const DYNAMIC_ALLOW: ReadonlySet<string> = new Set<string>();
    const glob = new Glob("apps/engine/src/http/routes/**/*.ts");
    // Two regexes: one finds every `requirePermission(` call site,
    // the other recognises a literal first argument. A site that
    // matches the first but not the second is dynamic. We scan
    // line-by-line and skip pure-comment lines (the doc-comment
    // `requirePermission(...)` placeholder used in route headers
    // should not trip the gate). Block-comment scanning is
    // best-effort; the worst case is a false positive a reviewer
    // can resolve by allow-listing the file.
    const callRe = /requirePermission\(/;
    const literalRe = /requirePermission\(\s*["']/;
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for await (const file of glob.scan({ cwd: ROOT, absolute: false, onlyFiles: true })) {
      if (DYNAMIC_ALLOW.has(file)) continue;
      const src = readFileSync(resolve(ROOT, file), "utf8");
      const lines = src.split("\n");
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i] ?? "";
        const trimmed = raw.trimStart();
        if (inBlockComment) {
          if (trimmed.includes("*/")) inBlockComment = false;
          continue;
        }
        if (trimmed.startsWith("/*")) {
          if (!trimmed.includes("*/")) inBlockComment = true;
          continue;
        }
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (callRe.test(raw) && !literalRe.test(raw)) {
          offenders.push({ file, line: i + 1, snippet: raw.trim().slice(0, 80) });
        }
      }
    }
    if (offenders.length > 0) {
      const out = offenders.map((o) => `  ${o.file}:${o.line}: ${o.snippet}`).join("\n");
      throw new Error(
        `requirePermission(...) called with a non-literal slug — the literal-string catalog gate cannot verify it:\n${out}\n\nUse a literal slug, or add the file to DYNAMIC_ALLOW with a comment.`,
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
