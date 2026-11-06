import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { staleSnapshotsIn } from "./lib/migration-snapshots.ts";

const metaDir = resolve(import.meta.dir, "..", "apps/engine/src/db/migrations/meta");
const stale = staleSnapshotsIn(metaDir);
for (const name of stale) rmSync(join(metaDir, name));
console.log(
  stale.length === 0
    ? "migration snapshots: only the latest is kept"
    : `migration snapshots: removed ${stale.join(", ")}`,
);
