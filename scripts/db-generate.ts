#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { staleSnapshotsIn } from "./lib/migration-snapshots.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const MIGRATIONS = "apps/engine/src/db/migrations";

export function publicTypesOf(baselineSql: string): Set<string> {
  return new Set(
    [...baselineSql.matchAll(/^CREATE TYPE public\.(\w+) AS/gm)].map((m) => m[1] ?? ""),
  );
}

export function normalizeMigrationSchema(
  sql: string,
  publicTypes: ReadonlySet<string> = new Set(),
): string {
  return sql
    .replace(/REFERENCES "public"\./g, 'REFERENCES "subkit".')
    .replace(/ALTER TYPE "(public|subkit)"\."(\w+)"/g, (_match, _schema: string, name: string) =>
      publicTypes.has(name) ? `ALTER TYPE "public"."${name}"` : `ALTER TYPE "subkit"."${name}"`,
    );
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function untracked(): Set<string> {
  return new Set(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", MIGRATIONS], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
}

function normalizeNewMigrations(): void {
  const directory = path.join(ROOT, MIGRATIONS);
  const journal = JSON.parse(readFileSync(path.join(directory, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const generated = untracked();
  const metadata = [...generated]
    .filter((file) => file.startsWith(`${MIGRATIONS}/meta/`) && file.endsWith(".json"))
    .map((file) => path.join(ROOT, file));
  metadata.push(path.join(directory, "meta/_journal.json"));
  execFileSync(process.execPath, ["x", "biome", "format", "--write", ...metadata], {
    cwd: ROOT,
    stdio: "pipe",
  });
  const publicTypes = publicTypesOf(
    readFileSync(path.join(directory, "0000_baseline_v2.sql"), "utf8"),
  );
  for (const entry of journal.entries) {
    const relative = `${MIGRATIONS}/${entry.tag}.sql`;
    if (!generated.has(relative)) continue;
    const file = path.join(ROOT, relative);
    const original = readFileSync(file, "utf8");
    const normalized = normalizeMigrationSchema(original, publicTypes);
    if (normalized !== original) writeFileSync(file, normalized);
  }
}

function pruneSnapshots(): void {
  const meta = path.join(ROOT, MIGRATIONS, "meta");
  const stale = staleSnapshotsIn(meta);
  for (const name of stale) rmSync(path.join(meta, name));
  console.log(
    stale.length === 0
      ? "migration snapshots: only the latest is kept"
      : `migration snapshots: removed ${stale.join(", ")}`,
  );
}

if (import.meta.main) {
  run("bunx", ["drizzle-kit", "generate", ...process.argv.slice(2)]);
  normalizeNewMigrations();
  pruneSnapshots();
  run("bun", ["scripts/gen-embedded-migrations.ts"]);
}
