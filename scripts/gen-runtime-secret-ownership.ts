import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderRuntimeSecretOwnershipSql } from "../apps/engine/src/db/runtime-secret-owner-sql.ts";

const directory = join(import.meta.dir, "../apps/engine/src/db/migrations");
const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const entry = journal.entries.find((value) => value.tag.endsWith("_runtime_secret_ownership"));
if (!entry) throw new Error("runtime_secret_ownership_migration_missing");
writeFileSync(join(directory, `${entry.tag}.sql`), renderRuntimeSecretOwnershipSql());
