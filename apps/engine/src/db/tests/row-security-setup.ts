import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { localDatabaseUrl } from "../../../../../scripts/lib/local-database-url.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import * as schema from "../schema/index.ts";
import { createTestDb, type TestDb } from "./setup.ts";

export const OWNER_PASSWORD = "synthetic-row-security-test-only";

export interface OwnerLogin {
  role: string;
  url: string;
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
}

export interface RowSecurityDb {
  ctx: TestDb;
  owner: OwnerLogin;
  cleanup: () => Promise<void>;
}

export function pgCode(error: unknown): string | undefined {
  const direct = (error as { code?: string }).code;
  return direct ?? (error as { cause?: { code?: string } }).cause?.code;
}

export async function failureCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
    return "no_error";
  } catch (error) {
    return pgCode(error);
  }
}

export function sealedItem(tenant_id: string, name: string) {
  return {
    tenant_id,
    kind: "secret" as const,
    name,
    environment: "dev" as const,
    mode: "bearer" as const,
    ciphertext: Buffer.from("fixture-ciphertext"),
    iv: Buffer.from("fixture-iv"),
    auth_tag: Buffer.from("fixture-tag"),
  };
}

export function loginRoleName(prefix: string, dbName: string): string {
  return `${prefix}_${dbName.replace(/[^a-z0-9_]/g, "").slice(-28)}`;
}

export async function createPlainLogin(admin: pg.Pool, role: string): Promise<void> {
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${OWNER_PASSWORD}'`,
  );
}

export async function handOverOwnership(admin: pg.Pool, role: string): Promise<void> {
  await admin.query(`
    DO $$
    DECLARE item record;
    BEGIN
      ALTER SCHEMA subkit OWNER TO "${role}";
      FOR item IN
        SELECT format('%I.%I', n.nspname, c.relname) AS name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'subkit' AND c.relkind IN ('r', 'p')
      LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO %I', item.name, '${role}');
      END LOOP;
      FOR item IN
        SELECT p.oid::regprocedure::text AS name
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'subkit'
      LOOP
        EXECUTE format('ALTER ROUTINE %s OWNER TO %I', item.name, '${role}');
      END LOOP;
    END $$`);
}

export function loginPool(url: string, role: string, max = 1): OwnerLogin {
  const target = new URL(url);
  target.username = role;
  target.password = OWNER_PASSWORD;
  const pool = new pg.Pool({ connectionString: target.toString(), max });
  pool.on("error", () => {});
  return { role, url: target.toString(), pool, db: drizzle(pool, { schema }) };
}

export async function dropLogins(...roles: string[]): Promise<void> {
  const admin = new pg.Client({ connectionString: localDatabaseUrl(testEnv) });
  await admin.connect();
  try {
    for (const role of roles) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  } finally {
    await admin.end();
  }
}

export async function createRowSecurityDb(label: string): Promise<RowSecurityDb> {
  const ctx = await createTestDb(label);
  const role = loginRoleName("rls_owner", ctx.dbName);
  await createPlainLogin(ctx.pool, role);
  await handOverOwnership(ctx.pool, role);
  const owner = loginPool(ctx.url, role);
  return {
    ctx,
    owner,
    cleanup: async () => {
      await owner.pool.end().catch(() => {});
      await ctx.cleanup();
      await dropLogins(role);
    },
  };
}
