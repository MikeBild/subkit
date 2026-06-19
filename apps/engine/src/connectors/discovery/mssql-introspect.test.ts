// Pure-function tests for the MSSQL introspect strategy. Live-DB
// integration is exercised manually — running SQL Server in CI is a
// containerization burden disproportionate to the marginal coverage
// over the postgres-introspect integration test (the rendering helper
// is shared in shape).

import { describe, expect, test } from "bun:test";
import { looksLikeMssqlUrl, renderMssqlSchemaMarkdown } from "./mssql-introspect.ts";

describe("looksLikeMssqlUrl", () => {
  test("matches mssql:// and sqlserver:// URIs", () => {
    expect(looksLikeMssqlUrl("mssql://u:p@h:1433/db")).toBe(true);
    expect(looksLikeMssqlUrl("sqlserver://h/db")).toBe(true);
    expect(looksLikeMssqlUrl("MSSQL://h/db")).toBe(true);
  });

  test("rejects non-mssql protocols", () => {
    expect(looksLikeMssqlUrl("postgres://h/db")).toBe(false);
    expect(looksLikeMssqlUrl("https://example.com")).toBe(false);
    expect(looksLikeMssqlUrl("not-a-url")).toBe(false);
  });
});

describe("renderMssqlSchemaMarkdown", () => {
  test("renders tables, columns, primary + foreign keys identical in shape to postgres", () => {
    const md = renderMssqlSchemaMarkdown({
      database: "AdventureWorks",
      columns: [
        {
          table_schema: "dbo",
          table_name: "customers",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_schema: "dbo",
          table_name: "customers",
          column_name: "email",
          data_type: "nvarchar",
          is_nullable: "NO",
          column_default: null,
          ordinal_position: 2,
        },
        {
          table_schema: "dbo",
          table_name: "orders",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          ordinal_position: 1,
        },
        {
          table_schema: "dbo",
          table_name: "orders",
          column_name: "customer_id",
          data_type: "int",
          is_nullable: "YES",
          column_default: null,
          ordinal_position: 2,
        },
      ],
      primaryKeys: [
        { table_schema: "dbo", table_name: "customers", column_name: "id" },
        { table_schema: "dbo", table_name: "orders", column_name: "id" },
      ],
      foreignKeys: [
        {
          table_schema: "dbo",
          table_name: "orders",
          column_name: "customer_id",
          foreign_table_schema: "dbo",
          foreign_table_name: "customers",
          foreign_column_name: "id",
          constraint_name: "fk_orders_customer",
        },
      ],
    });

    expect(md).toContain("# Database schema: AdventureWorks");
    expect(md).toContain("## dbo.customers");
    expect(md).toContain("## dbo.orders");
    expect(md).toMatch(/\| id \| int \| NO \|.*\| PK \|/);
    expect(md).toContain("| email | nvarchar | NO |");
    expect(md).toContain("**Foreign keys:**");
    expect(md).toContain("`customer_id` → `dbo.customers.id`");
  });

  test("emits truncation note when above maxTables", () => {
    const cols = Array.from({ length: 5 }, (_, i) => ({
      table_schema: "dbo",
      table_name: `t${i}`,
      column_name: "id",
      data_type: "int",
      is_nullable: "NO" as const,
      column_default: null,
      ordinal_position: 1,
    }));
    const md = renderMssqlSchemaMarkdown(
      { database: "X", columns: cols, primaryKeys: [], foreignKeys: [] },
      { maxTables: 2 },
    );
    expect(md).toContain("only first 2 tables shown");
    expect(md).toContain("## dbo.t0");
    expect(md).toContain("## dbo.t1");
    expect(md).not.toContain("## dbo.t2");
  });
});
