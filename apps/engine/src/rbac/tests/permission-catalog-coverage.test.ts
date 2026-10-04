import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { ALL_PERMISSION_NAMES } from "../catalog.ts";

function resolveRepoRoot(): string {
  const fromEnv = process.env.SUBKIT_REPO_ROOT;
  if (fromEnv && existsSync(resolve(fromEnv, "package.json"))) return fromEnv;
  return resolve(import.meta.dir, "..", "..", "..", "..", "..");
}

const ROOT = resolveRepoRoot();
{
  const pkgPath = resolve(ROOT, "package.json");
  let pkgName: string | undefined;
  try {
    pkgName = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }).name;
  } catch {}
  if (pkgName !== "subkit" || !existsSync(resolve(ROOT, "apps/engine"))) {
    throw new Error(
      `permission-catalog-coverage: resolved ROOT (${ROOT}) does not look like the subkit repo. ` +
        `Set SUBKIT_REPO_ROOT or move the test back under apps/engine/src/rbac/tests/.`,
    );
  }
}

const PERMISSION_TOKEN = /\b([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)\b/g;

const catalog = new Set<string>(ALL_PERMISSION_NAMES);

describe("RBAC permission catalog coverage", () => {
  test("every catalog entry has a permission name", () => {
    expect(catalog.size).toBeGreaterThan(0);
  });

  test('every literal `requirePermission("slug", ...)` site references a known catalog slug', async () => {
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
    const DYNAMIC_ALLOW: ReadonlySet<string> = new Set<string>();
    const glob = new Glob("apps/engine/src/http/routes/**/*.ts");
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
    const globs = [
      "apps/engine/src/mcp/**/*.ts",
      "apps/engine/src/conversations/tools/**/*.ts",
      "apps/engine/src/conversations/services/**/*.ts",
      "apps/engine/src/connectors/services/**/*.ts",
      "apps/engine/src/queue/**/*.ts",
    ];
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

  test("execution:signal is in the catalog (recipe prerequisite + signals route)", () => {
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
            if (catalog.has(slug)) continue;
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
