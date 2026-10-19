import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderRbacTenantBoundarySql } from "../apps/engine/src/db/rbac-tenant-sql.ts";

const directory = join(import.meta.dir, "../apps/engine/src/db/migrations");
const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const entry = journal.entries.find((value) => value.tag.endsWith("_rbac_tenant_boundary"));
if (!entry) throw new Error("rbac_tenant_boundary_migration_missing");
writeFileSync(join(directory, `${entry.tag}.sql`), renderRbacTenantBoundarySql());
