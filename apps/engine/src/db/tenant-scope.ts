import { sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { logger } from "../logging/index.ts";
import type { Executor, Transaction } from "./client.ts";
import {
  decideScopeEntry,
  RLS_SCOPE_SETTING,
  type RowScope,
  type RowScopeKind,
  TENANT_ROLE,
  TENANT_SETTING,
} from "./core/tenant-scope.ts";

declare const rowScoped: unique symbol;

export type ScopedTx = Transaction & { readonly [rowScoped]: RowScopeKind };

type PreviousScope = {
  previous_role: string;
  previous_tenant: string | null;
  previous_scope: string | null;
};

export async function withRowScope<T>(
  db: Executor,
  scope: RowScope,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const decision = decideScopeEntry(scope);
  if (decision.kind === "rejected") throw new TypeError(decision.reason);
  const { entry } = decision;
  if (scope.kind === "system")
    logger.debug({
      module: "db",
      action: "row_scope.system",
      msg: "entering the system row scope",
      reason: scope.reason,
    });
  const nested = db instanceof PgTransaction;
  return db.transaction(async (tx) => {
    const entered = await tx.execute<PreviousScope>(
      sql`SELECT current_setting('role') AS previous_role,
                 current_setting(${TENANT_SETTING}, true) AS previous_tenant,
                 current_setting(${RLS_SCOPE_SETTING}, true) AS previous_scope,
                 set_config(
                   'role',
                   CASE WHEN ${entry.assume_tenant_role}::boolean
                     AND EXISTS (
                       SELECT 1 FROM pg_catalog.pg_roles login
                       WHERE login.rolname = session_user
                         AND (login.rolsuper OR login.rolbypassrls)
                     )
                     AND EXISTS (
                       SELECT 1 FROM pg_catalog.pg_roles r
                       WHERE r.rolname = ${TENANT_ROLE}
                         AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')
                         AND pg_catalog.has_schema_privilege(r.oid, 'subkit', 'USAGE')
                     ) THEN ${TENANT_ROLE} ELSE current_setting('role') END,
                   true
                 ),
                 set_config(${TENANT_SETTING}, ${entry.tenant_id}, true),
                 set_config(${RLS_SCOPE_SETTING}, ${entry.rls_scope}, true)`,
    );
    const previous = entered.rows[0];
    if (!previous) throw new Error("row scope could not be entered");
    const result = await fn(tx as ScopedTx);
    if (nested)
      await tx.execute(
        sql`SELECT set_config('role', ${previous.previous_role}, true),
                   set_config(${TENANT_SETTING}, ${previous.previous_tenant ?? ""}, true),
                   set_config(${RLS_SCOPE_SETTING}, ${previous.previous_scope ?? ""}, true)`,
      );
    return result;
  });
}

export const withTenantScope = <T>(
  db: Executor,
  tenant_id: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> => withRowScope(db, { kind: "tenant", tenant_id }, fn);

export const withSystemScope = <T>(
  db: Executor,
  reason: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> => withRowScope(db, { kind: "system", reason }, fn);
