#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Outdated {
  readonly name: string;
  readonly current: string;
  readonly update: string;
  readonly latest: string;
}

export interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly patchedDependencies?: Readonly<Record<string, string>>;
}

export type Decision =
  | { readonly kind: "apply"; readonly dep: Outdated }
  | { readonly kind: "hold"; readonly dep: Outdated; readonly reason: string };

export const PACKAGES = [".", "apps/cockpit", "apps/desktop"] as const;

export function parseOutdated(table: string): Outdated[] {
  return table
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.startsWith("|-"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length >= 4 && cells[0] !== "Package")
    .map(([name = "", current = "", update = "", latest = ""]) => ({
      name: name.replace(/\s+\((?:dev|peer|optional)\)$/, ""),
      current,
      update,
      latest,
    }));
}

const major = (version: string): string => version.split(".")[0] ?? "";

function patchedNames(manifest: Manifest): Set<string> {
  return new Set(
    Object.keys(manifest.patchedDependencies ?? {}).map((key) =>
      key.slice(0, key.lastIndexOf("@")),
    ),
  );
}

export function decide(deps: readonly Outdated[], manifest: Manifest): Decision[] {
  const patched = patchedNames(manifest);
  const specs = { ...manifest.devDependencies, ...manifest.dependencies };
  return deps.map((dep): Decision => {
    const spec = specs[dep.name] ?? "";
    const hold = (reason: string): Decision => ({ kind: "hold", dep, reason });
    if (!spec) return hold("not a direct dependency");
    if (patched.has(dep.name)) return hold("patched, update the patch by hand");
    if (manifest.overrides?.[dep.name]) return hold("pinned by overrides");
    if (/^(?:file|link|workspace|git|github|https?):/.test(spec))
      return hold("not from the registry");
    if (!/^[\^~]/.test(spec)) return hold("exact pin, update by hand");
    if (dep.update === dep.current)
      return hold(
        major(dep.latest) !== major(dep.current)
          ? "new major, update by hand"
          : "range allows no update",
      );
    return { kind: "apply", dep };
  });
}

export function report(dir: string, decisions: readonly Decision[]): string[] {
  if (decisions.length === 0) return [`${dir}: up to date`];
  return decisions.map((d) =>
    d.kind === "apply"
      ? `${dir}: update ${d.dep.name} ${d.dep.current} → ${d.dep.update}`
      : `${dir}: hold ${d.dep.name} ${d.dep.current} (latest ${d.dep.latest}): ${d.reason}`,
  );
}

if (import.meta.main) {
  const repo = join(import.meta.dir, "..");
  const check = process.argv.includes("--check");
  let applied = 0;
  for (const dir of PACKAGES) {
    const cwd = join(repo, dir);
    const outdated = spawnSync("bun", ["outdated"], { cwd, encoding: "utf8" });
    if (outdated.status !== 0) {
      console.error(`${dir}: bun outdated failed\n${outdated.stderr}`);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Manifest;
    const decisions = decide(parseOutdated(outdated.stdout), manifest);
    for (const line of report(dir, decisions)) console.log(line);
    const names = decisions.flatMap((d) => (d.kind === "apply" ? [d.dep.name] : []));
    if (check || names.length === 0) continue;
    const update = spawnSync("bun", ["update", ...names], { cwd, stdio: "inherit" });
    if (update.status !== 0) process.exit(update.status ?? 1);
    applied += names.length;
  }
  if (!check && applied > 0)
    console.log(`\n${applied} updates applied. Run bun run verify static, then commit them.`);
}
