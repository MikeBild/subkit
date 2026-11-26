import { describe, expect, test } from "bun:test";
import { parseSource } from "../audit/imports.ts";
import { isRowScopeScope, ROW_SCOPED_EXPORTS, rowScopeHits } from "../audit/row-scope.ts";

const FILE = "apps/engine/src/feature/service.ts";
const resolve = (specifier: string) =>
  specifier === "../db/index.ts" ? "apps/engine/src/db/index.ts" : specifier;

function hits(source: string) {
  return rowScopeHits(parseSource(FILE, source), resolve).map(({ table, how }) => ({ table, how }));
}

const IMPORTS = `import { vaultItems, connectors, withTenantScope, withSystemScope, type ScopedTx } from "../db/index.ts";\nimport * as schema from "../db/index.ts";\n`;

describe("row scope rule", () => {
  test("derives every drizzle export from the single table list", () => {
    expect(ROW_SCOPED_EXPORTS.get("vaultItems")).toBe("vault_items");
    expect(ROW_SCOPED_EXPORTS.get("cockpitPushSubscriptions")).toBe("cockpit_push_subscriptions");
    expect(ROW_SCOPED_EXPORTS.get("webhookHeldDeliveries")).toBe("webhook_held_deliveries");
    expect(ROW_SCOPED_EXPORTS.size).toBe(10);
  });

  test("flags a deliberately unscoped query on a row-scoped table", () => {
    expect(hits(`${IMPORTS}export const f = (db) => db.select().from(vaultItems);`)).toEqual([
      { table: "vault_items", how: "table" },
    ]);
  });

  test("flags joins, relational queries, namespace access and sql interpolation", () => {
    const source = `${IMPORTS}
      export async function f(db) {
        await db.select().from(connectors).innerJoin(vaultItems, x);
        await db.query.vaultItems.findFirst();
        await db.delete(schema.vaultItems);
        await db.execute(sql\`DELETE FROM \${vaultItems}\`);
      }`;
    expect(hits(source)).toHaveLength(4);
  });

  test("accepts access inside a scope callback or a ScopedTx helper", () => {
    const source = `${IMPORTS}
      export const a = (db, t) => withTenantScope(db, t, (tx) => tx.select().from(vaultItems));
      export const b = (db) => withSystemScope(db, "sweep", async (tx) => tx.delete(vaultItems));
      async function c(tx: ScopedTx) { return tx.update(vaultItems).set({}); }`;
    expect(hits(source)).toEqual([]);
  });

  test("ignores other tables, column references, type positions and type-only imports", () => {
    const source = `import type { webhooksInbound } from "../db/index.ts";\n${IMPORTS}
      type Row = typeof vaultItems.$inferSelect;
      export const where = (id) => eq(vaultItems.id, id);
      export const g = (db) => db.select().from(connectors);`;
    expect(hits(source)).toEqual([]);
  });

  test("flags raw SQL naming a row-scoped table unless it carries the allow directive", () => {
    expect(
      hits(`export const f = (pool) => pool.query("SELECT id FROM subkit.vault_items");`),
    ).toEqual([{ table: "vault_items", how: "raw_sql" }]);
    expect(
      hits(
        `// row-scope-allowed: reads catalog flags only\nconst FLAGS_SQL = "SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('subkit.vault_items')";`,
      ),
    ).toEqual([]);
    expect(hits(`logger.info({ msg: "no chat_workspaces row from that workspace" });`)).toEqual([]);
  });

  test("covers engine production sources but not schema or migrations", () => {
    expect(isRowScopeScope("apps/engine/src/vault/service.ts")).toBe(true);
    expect(isRowScopeScope("apps/engine/src/db/schema/connectors.ts")).toBe(false);
    expect(isRowScopeScope("apps/engine/src/db/migrations/embedded.ts")).toBe(false);
    expect(isRowScopeScope("apps/cockpit/src/app.ts")).toBe(false);
  });
});
