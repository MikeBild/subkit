#!/usr/bin/env bun
//
// check:deps-phantom — gate that every imported package is declared.
//
// Walks bare-specifier imports across all workspaces (via Bun's transpiler, so
// `.from()` method calls, strings, and comments are not mistaken for imports)
// and flags any package imported in source but NOT declared in the root
// package.json (deps/devDeps/peer/optional), provided as a workspace package,
// or resolved through a tsconfig path alias. These "phantom" deps resolve only
// transitively today, so an upstream bump can break them silently — declaring
// them with a pinned range is the fix.
//
// Deterministic and offline (no install), so it is safe to gate in CI.
// Unused-dependency detection is the inverse problem and stays advisory (it is
// heuristic and false-positive-prone) — see the housekeeping workflow.
//
// Wired into `package.json` (`bun run check:deps-phantom`), `verify`, and
// `.github/workflows/ci.yml`. Output:
//   WARN  <pkg>  (imported in <file>[, +N more])
// Exits non-zero on any phantom dep.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Runtime modules the bun/node platform provides without a package.json entry.
const PLATFORM = new Set(["bun"]);

function tracked(...globs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...globs], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

// tsconfig `paths` alias prefixes (e.g. "@engine" from "@engine/*") map to
// internal source, not npm packages.
export function aliasPrefixes(tsconfigText: string): string[] {
  const prefixes = new Set<string>();
  for (const m of tsconfigText.matchAll(/"([^"*]+)\/\*"\s*:/g)) prefixes.add(m[1]);
  return [...prefixes];
}

// Reduce an import specifier to its package name, or null if it is not an
// external package (relative, absolute, builtin, platform, or alias-internal).
export function pkgNameOf(spec: string, aliases: readonly string[]): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return null;
  if (isBuiltin(spec)) return null;
  for (const a of aliases) if (spec === a || spec.startsWith(`${a}/`)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || PLATFORM.has(name) || isBuiltin(name)) return null;
  return name;
}

// Convert fully type-only imports/exports into value form so Bun's transpiler
// (which elides type-only statements) still reports their specifiers. The
// `\s+type\s` guard never matches inline `import { type X }` or identifiers.
export function detype(code: string): string {
  return code.replace(/\bimport\s+type\s/g, "import ").replace(/\bexport\s+type\s/g, "export ");
}

// Extract bare external-package specifiers from one source file's text.
export function importedPackages(
  code: string,
  ext: "ts" | "tsx",
  aliases: readonly string[],
): string[] {
  const transpiler = new Bun.Transpiler({ loader: ext });
  let imports: { path: string }[];
  try {
    imports = transpiler.scanImports(detype(code));
  } catch {
    return []; // unparseable file — skip rather than fail the gate spuriously
  }
  const out: string[] = [];
  for (const imp of imports) {
    const name = pkgNameOf(imp.path, aliases);
    if (name) out.push(name);
  }
  return out;
}

function declaredPackages(): Set<string> {
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const names = new Set<string>([
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {}),
    ...Object.keys(root.peerDependencies ?? {}),
    ...Object.keys(root.optionalDependencies ?? {}),
  ]);
  for (const rel of tracked("apps/*/package.json", "packages/*/package.json")) {
    try {
      const name = JSON.parse(readFileSync(join(REPO, rel), "utf8")).name;
      if (name) names.add(name);
    } catch {
      // unreadable workspace manifest — skip
    }
  }
  return names;
}

function findPhantom(): Map<string, string[]> {
  const declared = declaredPackages();
  let tsconfig = "";
  try {
    tsconfig = readFileSync(join(REPO, "tsconfig.json"), "utf8");
  } catch {
    // no tsconfig — no aliases
  }
  const aliases = aliasPrefixes(tsconfig);
  const phantom = new Map<string, string[]>();
  for (const rel of tracked(
    "apps/**/*.ts",
    "apps/**/*.tsx",
    "packages/**/*.ts",
    "packages/**/*.tsx",
    "scripts/**/*.ts",
  )) {
    if (rel.endsWith(".d.ts")) continue;
    let code: string;
    try {
      code = readFileSync(join(REPO, rel), "utf8");
    } catch {
      continue;
    }
    for (const name of importedPackages(code, rel.endsWith(".tsx") ? "tsx" : "ts", aliases)) {
      if (declared.has(name)) continue;
      const files = phantom.get(name) ?? [];
      if (!files.includes(rel)) files.push(rel);
      phantom.set(name, files);
    }
  }
  return phantom;
}

if (import.meta.main) {
  const phantom = findPhantom();
  const names = [...phantom.keys()].sort();
  for (const name of names) {
    const files = phantom.get(name)!.sort();
    const more = files.length > 1 ? `, +${files.length - 1} more` : "";
    console.log(`WARN  ${name}  (imported in ${files[0]}${more})`);
  }
  console.log(
    names.length === 0
      ? "check:deps-phantom OK — every imported package is declared"
      : `check:deps-phantom FAIL — ${names.length} undeclared (phantom) dependenc${names.length === 1 ? "y" : "ies"}`,
  );
  process.exit(names.length === 0 ? 0 : 1);
}
