import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderHostedQuotaSql } from "../apps/engine/src/db/hosted-quota-sql.ts";

const directory = join(import.meta.dir, "../apps/engine/src/db/migrations");
const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const entry = journal.entries.find((value) => value.tag.endsWith("_hosted_resource_quota"));
if (!entry) throw new Error("hosted_quota_migration_missing");
writeFileSync(join(directory, `${entry.tag}.sql`), renderHostedQuotaSql());
