#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./audit/files.ts";
import { collectImportsFromSource, parseSource } from "./audit/imports.ts";
import { reviewedClosurePlan } from "./audit/mutation-closure.ts";
import { assertCompletePureTargetInventory } from "./audit/pure-targets.ts";

const REPO = resolve(join(fileURLToPath(import.meta.url), "..", "..", "..", ".."));
const OUT = join(REPO, ".artifacts/architecture-release/p1");
const files = ["apps/cockpit/src", "apps/engine/src", "apps/sk/src", "packages", "tests"].flatMap(
  (root) =>
    listFiles(join(REPO, root), (file) => /\.(ts|tsx)$/.test(file)).map((file) =>
      relative(REPO, file),
    ),
);
const read = (path: string) => {
  try {
    return readFileSync(join(REPO, path), "utf8");
  } catch {
    return null;
  }
};
const entries = assertCompletePureTargetInventory(files);
const key = (path: string) =>
  path.startsWith("packages/cli-core/")
    ? "cli-core"
    : path.startsWith("packages/shared/")
      ? "shared"
      : path.startsWith("apps/cockpit/")
        ? "cockpit"
        : path.startsWith("apps/sk/")
          ? "sk"
          : path.slice("apps/engine/src/".length).split("/")[0]!;
const groups = new Map<string, string[]>();
for (const entry of entries)
  groups.set(key(entry.path), [...(groups.get(key(entry.path)) ?? []), entry.path]);
const shards = [...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, targets]) => {
    const plan = reviewedClosurePlan({
      targets,
      files,
      readText: read,
      tsconfig: readFileSync(join(REPO, "tsconfig.json"), "utf8"),
      cockpitTsconfig: readFileSync(join(REPO, "apps/cockpit/tsconfig.json"), "utf8"),
      declared: [],
    });
    const body = plan.tests.map((test) => read(test.path) ?? "").join("\n");
    const resource_tags = [
      ...(/docker|DATABASE_URL|postgres|pglite|drizzle/i.test(body) ? ["db"] : []),
      ...(/Bun\.serve|listen\(|port:\s*\d+/i.test(body) ? ["ports"] : []),
      ...(/process\.(env|stdout|stderr)|globalThis\./i.test(body) ? ["global-state"] : []),
    ];
    return {
      id,
      targets: targets.sort(),
      tests: plan.tests,
      consumers: plan.consumers,
      resource_tags,
    };
  });
const ledger = entries.flatMap((entry) =>
  collectImportsFromSource(parseSource(entry.path, read(entry.path) ?? "")).map((ref) => ({
    importing_target: entry.path,
    specifier: ref.specifier,
    classification: "static",
    type_only: ref.typeOnly,
    line: ref.line,
  })),
);
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "dynamic-import-ledger.json"),
  `${JSON.stringify({ version: 1, entries: ledger }, null, 2)}\n`,
);
writeFileSync(
  join(OUT, "wave-candidate.json"),
  `${JSON.stringify({ version: 1, status: "candidate_unaccepted", target_count: entries.length, shards, unresolved_constraints: shards.filter((shard) => shard.resource_tags.length > 1).map((shard) => ({ shard: shard.id, resource_tags: shard.resource_tags })) }, null, 2)}\n`,
);
console.log(`generated candidate: ${entries.length} targets, ${shards.length} shards`);
