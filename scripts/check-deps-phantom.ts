#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORM = new Set(["bun"]);

function tracked(...globs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", ...globs], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

export function aliasPrefixes(tsconfigText: string): string[] {
  const prefixes = new Set<string>();
  for (const m of tsconfigText.matchAll(/"([^"*]+)\/\*"\s*:/g)) prefixes.add(m[1]);
  return [...prefixes];
}

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

export function detype(code: string): string {
  return code.replace(/\bimport\s+type\s/g, "import ").replace(/\bexport\s+type\s/g, "export ");
}

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
    return [];
  }
  const out: string[] = [];
  for (const imp of imports) {
    const name = pkgNameOf(imp.path, aliases);
    if (name) out.push(name);
  }
  return out;
}

function declaredPackages(): Set<string> {
  const names = new Set<string>();
  for (const rel of tracked("package.json", "apps/*/package.json", "packages/*/package.json")) {
    try {
      const manifest = JSON.parse(readFileSync(join(REPO, rel), "utf8"));
      if (manifest.name) names.add(manifest.name);
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
      }
    } catch {}
  }
  return names;
}

function findPhantom(): Map<string, string[]> {
  const declared = declaredPackages();
  const aliases = new Set<string>();
  for (const rel of tracked("tsconfig.json", "apps/*/tsconfig.json", "packages/*/tsconfig.json")) {
    try {
      for (const prefix of aliasPrefixes(readFileSync(join(REPO, rel), "utf8"))) {
        aliases.add(prefix);
      }
    } catch {}
  }
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
    for (const name of importedPackages(code, rel.endsWith(".tsx") ? "tsx" : "ts", [...aliases])) {
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
