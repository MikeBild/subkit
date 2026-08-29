// Integration test for the Postgres introspection strategy. Uses a real
// per-test database (createTestDb) so we exercise the actual catalog
// queries rather than mocking the driver.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { looksLikePostgresUrl, postgresIntrospectStrategy } from "./postgres-introspect.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("postgres_introspect");
  // Seed a small schema so the corpus has interesting content.
  await ctx.pool.query(`
    CREATE TABLE customers (
      id serial PRIMARY KEY,
      email text NOT NULL,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      customer_id int REFERENCES customers(id),
      total_cents int,
      status text DEFAULT 'pending'
    );
  `);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("looksLikePostgresUrl", () => {
  test("matches postgres:// and postgresql:// URIs", () => {
    expect(looksLikePostgresUrl("postgres://u:p@h:5432/db")).toBe(true);
    expect(looksLikePostgresUrl("postgresql://h/db")).toBe(true);
    expect(looksLikePostgresUrl("POSTGRES://h/db")).toBe(true);
  });

  test("rejects non-postgres protocols", () => {
    expect(looksLikePostgresUrl("https://example.com")).toBe(false);
    expect(looksLikePostgresUrl("mysql://h/db")).toBe(false);
    expect(looksLikePostgresUrl("not-a-url")).toBe(false);
  });
});

describe("postgresIntrospectStrategy", () => {
  test("emits a Markdown corpus with tables, columns, primary + foreign keys", async () => {
    const result = await postgresIntrospectStrategy.fetch(ctx.url, {});

    expect(result.strategy).toBe("postgres-introspect");
    expect(result.spec_version).toBeNull();
    expect(result.endpoints).toEqual([]); // SQL doesn't have HTTP endpoints
    expect(result.title).toBeTruthy(); // current_database() returns the test db name

    const corpus = result.text_corpus ?? "";
    // Section per table.
    expect(corpus).toContain("## subkit.customers");
    expect(corpus).toContain("## subkit.orders");
    // Columns + nullability.
    expect(corpus).toContain("| email | text | NO |");
    expect(corpus).toContain("| total_cents | integer | YES |");
    // PK marker on serial-id columns.
    expect(corpus).toMatch(/\| id \| integer \| NO \|.*\| PK \|/);
    // Foreign-key callout on orders.customer_id.
    expect(corpus).toContain("**Foreign keys:**");
    expect(corpus).toContain("`customer_id` → `subkit.customers.id`");
  });

  test("declines non-postgres URLs", () => {
    expect(postgresIntrospectStrategy.canHandle("https://api.example.com")).toBe(false);
    expect(postgresIntrospectStrategy.canHandle("postgres://h/db")).toBe(true);
  });
});
