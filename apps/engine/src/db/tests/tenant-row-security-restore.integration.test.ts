import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { vaultItems } from "../schema/index.ts";
import { readTenantRoleFacts, tenantRolePreflight } from "../tenant-role-preflight.ts";
import { withSystemScope, withTenantScope } from "../tenant-scope.ts";
import {
  createPlainLogin,
  createRowSecurityDb,
  dropLogins,
  loginPool,
  loginRoleName,
  type OwnerLogin,
  type RowSecurityDb,
  sealedItem,
} from "./row-security-setup.ts";
import { owningPidFromTestDbName, TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

const pgDump = Bun.which("pg_dump");
const pgRestore = Bun.which("pg_restore");
const SYSTEM_SCOPE_OPTIONS = "-c subkit.rls_scope=system";

let rls: RowSecurityDb;
let restoredRole: string;
let restoredDb: string;
let restored: OwnerLogin;
let workdir: string;
let tenantA: string;

function connectionOnly(url: string): string {
  const target = new URL(url);
  target.search = "";
  return target.toString();
}

async function run(command: string, args: string[]): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    env: { ...testEnv, PGOPTIONS: SYSTEM_SCOPE_OPTIONS },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`${command} failed (${code}): ${await new Response(child.stderr).text()}`);
}

describe.skipIf(!pgDump || !pgRestore)("backup and restore under forced row security", () => {
  beforeAll(async () => {
    rls = await createRowSecurityDb("tenant_row_security_dump");
    tenantA = (await seedTenant(rls.owner.db, { slug: "row-security-dump-a" })).id;
    const tenantB = (await seedTenant(rls.owner.db, { slug: "row-security-dump-b" })).id;
    await withSystemScope(rls.owner.db, "seed fixture secrets", (tx) =>
      tx
        .insert(vaultItems)
        .values([sealedItem(tenantA, "a-token"), sealedItem(tenantB, "b-token")]),
    );
    workdir = mkdtempSync(join(tmpdir(), "row-security-dump-"));
    restoredDb = rls.ctx.dbName.replace(/^test_/, "test_restored_");
    restoredRole = loginRoleName("rls_restore", rls.ctx.dbName);
    await createPlainLogin(rls.ctx.pool, restoredRole);
    await rls.ctx.pool.query(`CREATE DATABASE "${restoredDb}" OWNER "${restoredRole}"`);
    const target = new URL(rls.ctx.url);
    target.pathname = `/${restoredDb}`;
    restored = loginPool(target.toString(), restoredRole);
  }, TEST_DB_HOOK_TIMEOUT);

  afterAll(async () => {
    await restored?.pool.end().catch(() => {});
    await rls?.ctx.pool
      .query(`DROP DATABASE IF EXISTS "${restoredDb}" WITH (FORCE)`)
      .catch(() => {});
    await rls?.cleanup();
    if (restoredRole) await dropLogins(restoredRole);
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  }, TEST_DB_HOOK_TIMEOUT);

  test("the owner dumps with row security enabled and restores into a database without the tenant role", async () => {
    expect(owningPidFromTestDbName(restoredDb)).toBe(process.pid);
    const dump = join(workdir, "subkit.dump");
    await run(pgDump as string, [
      "--enable-row-security",
      "-Fc",
      "-d",
      connectionOnly(rls.owner.url),
      "-f",
      dump,
    ]);
    await run(pgRestore as string, [
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "-d",
      connectionOnly(restored.url),
      dump,
    ]);

    const facts = await readTenantRoleFacts(restored.pool);
    expect(facts).toMatchObject({ is_superuser: false, row_security_forced: true });
    expect(await tenantRolePreflight(restored.pool)).toMatchObject({ verdict: "ready" });

    const unscoped = await restored.pool.query("SELECT count(*)::int AS n FROM subkit.vault_items");
    expect(unscoped.rows[0]).toEqual({ n: 0 });
    const names = await withTenantScope(restored.db, tenantA, async (tx) =>
      // tenant-filter:exempt — proves the restored policy filters without a tenant predicate
      (await tx.select({ name: vaultItems.name }).from(vaultItems)).map((row) => row.name),
    );
    expect(names).toEqual(["a-token"]);
    const all = await withSystemScope(
      restored.db,
      "restore check",
      async (tx) =>
        // tenant-filter:exempt — counts every restored secret
        (await tx.select({ id: vaultItems.id }).from(vaultItems)).length,
    );
    expect(all).toBe(2);
  });
});
