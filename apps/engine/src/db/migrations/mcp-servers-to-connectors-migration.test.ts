import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp_connector_constraints");
  const {
    rows: [t],
  } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO tenants (slug, display_name)
    VALUES (${"t-mcp-migrate"}, ${"McpMigrate"}) RETURNING id
  `);
  if (!t) throw new Error("tenant seed failed");
  tenant_id = t.id;
});

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function rejectionText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    return `${String(err)} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

test("the slug shape check now refuses a double underscore", async () => {
  const text = await rejectionText(() =>
    ctx.db.execute(
      sql`INSERT INTO connectors (tenant_id, slug, display_name, driver) VALUES (${tenant_id}, 'bad__slug', 'Bad', 'http')`,
    ),
  );
  expect(text).toContain("connectors_slug_shape_check");
});

test("an inline mcp auth secret is refused at the storage layer", async () => {
  const text = await rejectionText(() =>
    ctx.db.execute(
      sql`INSERT INTO connectors (tenant_id, slug, display_name, driver, config)
          VALUES (${tenant_id}, 'inline-secret', 'Inline', 'mcp',
                  '{"mcp":{"transport":"http","auth":{"kind":"bearer","client_secret":"nope"}}}'::jsonb)`,
    ),
  );
  expect(text).toContain("connectors_mcp_auth_no_inline_secrets_check");
});
