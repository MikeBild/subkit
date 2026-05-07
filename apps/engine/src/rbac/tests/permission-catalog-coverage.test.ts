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
//
//   4. Every literal `permission: "slug"` site outside the HTTP
//      route surface (MCP capabilities, conversation tools, queue
//      handlers — anywhere that calls `can(...)` with an inline
//      object) must also reference a catalog slug. Per #147 review
//      W-2: the `requirePermission` regex above is HTTP-only; MCP
//      uses the lower-level `can(db, { permission: ... })` shape and
//      the original test silently passed any drift there.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { ALL_PERMISSION_NAMES } from "../catalog.ts";

// Repo root resolution. `SUBKIT_REPO_ROOT` env override wins (CI runners
// with non-standard layouts can pin it); otherwise resolve statically
// from this file's location and assert at module load that the resolved
// root contains `apps/engine`. Per #147 review W-5 (rename from the
// brittle hard-coded `../../../../..`) and S-2 (cheap structural check
// instead of a parent-walk on every test invocation).
function resolveRepoRoot(): string {
  const fromEnv = process.env.SUBKIT_REPO_ROOT;
  if (fromEnv && existsSync(resolve(fromEnv, "package.json"))) return fromEnv;
  // This file lives at `apps/engine/src/rbac/tests/...` — five levels
  // up from `import.meta.dir` is the repo root.
  return resolve(import.meta.dir, "..", "..", "..", "..", "..");
}

const ROOT = resolveRepoRoot();
// Sanity-assert at module load: a stale `import.meta.dir` (file moved)
// or a wrong `SUBKIT_REPO_ROOT` would silently glob the wrong tree.
// Failing here gives the operator a useful error instead of an empty
// scan that passes the catalog-coverage gates by accident.
{
  const pkgPath = resolve(ROOT, "package.json");
  let pkgName: string | undefined;
  try {
    pkgName = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }).name;
  } catch {
    /* fall through to the existsSync check */
  }
  if (pkgName !== "subkit" || !existsSync(resolve(ROOT, "apps/engine"))) {
    throw new Error(
      `permission-catalog-coverage: resolved ROOT (${ROOT}) does not look like the subkit repo. ` +
        `Set SUBKIT_REPO_ROOT or move the test back under apps/engine/src/rbac/tests/.`,
    );
  }
}

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

  test('every literal `permission: "slug"` site outside http/routes references a known catalog slug', async () => {
    // Covers the `can(db, { permission: "slug", ... })` shape used by
    // MCP capabilities, conversation tools, and any queue handler
    // that performs an explicit RBAC check. The HTTP `requirePermission`
    // regex above doesn't see these sites — without this gate, an
    // MCP equivalent of the #147 / S-4 `execution:signal` miss would
    // surface only at first runtime call.
    const globs = [
      "apps/engine/src/mcp/**/*.ts",
      "apps/engine/src/conversations/tools/**/*.ts",
      "apps/engine/src/conversations/services/**/*.ts",
      "apps/engine/src/connectors/services/**/*.ts",
      "apps/engine/src/queue/**/*.ts",
    ];
    // Match `permission: "slug"` — `can()` arg shape — and exclude
    // test files (which legitimately reference dummy slugs).
    const literalRe = /\bpermission:\s*["']([^"']+)["']/g;
    const offenders: Array<{ file: string; slug: string }> = [];
    for (const pattern of globs) {
      const glob = new Glob(pattern);
      for await (const file of glob.scan({ cwd: ROOT, absolute: false, onlyFiles: true })) {
        if (file.endsWith(".test.ts") || file.includes("/tests/")) continue;
        const src = readFileSync(resolve(ROOT, file), "utf8");
        literalRe.lastIndex = 0;
        for (const m of src.matchAll(literalRe)) {
          const slug = m[1] ?? "";
          // Only flag when the slug is permission-shaped and the
          // noun matches a catalog resource_type — recipes / log
          // metadata / audit metadata may legitimately contain
          // `permission: "..."` for non-RBAC reasons.
          if (!/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(slug)) continue;
          const noun = slug.split(":")[0];
          const isResourceNoun = [...catalog].some((p) => p.startsWith(`${noun}:`));
          if (isResourceNoun && !catalog.has(slug)) {
            offenders.push({ file, slug });
          }
        }
      }
    }
    if (offenders.length > 0) {
      const out = offenders.map((o) => `  ${o.file}: permission: "${o.slug}"`).join("\n");
      throw new Error(
        `permission slug not in apps/engine/src/rbac/permissions.json:\n${out}\n\nAdd the entry or fix the slug.`,
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
