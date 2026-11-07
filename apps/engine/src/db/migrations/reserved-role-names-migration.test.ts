import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { seedTenant } from "../../test-helpers/seed.ts";
import { roles } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const TAG = "0003_reserved_role_names";
const CONSTRAINT = "roles_reserved_name_builtin_only";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("reserved-role-names-migration");
  tenantId = (await seedTenant(ctx.db, { slug: "reserved-roles", display_name: "Reserved" })).id;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function statements(): string[] {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} missing from the embedded bundle`);
  return found.statements;
}

async function customRole(name: string): Promise<string> {
  const [row] = await ctx.db
    .insert(roles)
    .values({ tenant_id: tenantId, name, is_builtin: false })
    .returning({ id: roles.id });
  if (!row) throw new Error("role insert returned no row");
  return row.id;
}

async function refusal(name: string): Promise<string | undefined> {
  try {
    await customRole(name);
  } catch (err) {
    return (err as { cause?: { constraint?: string } }).cause?.constraint;
  }
  return undefined;
}

async function nameOf(id: string): Promise<string | undefined> {
  const [row] = await ctx.db.select({ name: roles.name }).from(roles).where(eq(roles.id, id));
  return row?.name;
}

describe("reserved role names migration", () => {
  test("the database refuses a custom role with a built-in name", async () => {
    expect(await refusal("admin")).toBe(CONSTRAINT);
    const rows = await ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.tenant_id, tenantId), eq(roles.name, "admin"), eq(roles.is_builtin, false)),
      );
    expect(rows).toEqual([]);
  });

  test("custom roles that already carry a built-in name are renamed and others stay", async () => {
    await ctx.db.execute(sql.raw(`ALTER TABLE subkit.roles DROP CONSTRAINT ${CONSTRAINT}`));
    const shadowAdmin = await customRole("admin");
    const shadowEnduser = await customRole("enduser");
    const regular = await customRole("ops");
    const builtin = await ctx.db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(eq(roles.is_builtin, true));

    await ctx.db.transaction(async (tx) => {
      for (const statement of statements()) await tx.execute(sql.raw(statement));
    });

    expect(await nameOf(shadowAdmin)).toBe(`admin-custom-${shadowAdmin.slice(0, 8)}`);
    expect(await nameOf(shadowEnduser)).toBe(`enduser-custom-${shadowEnduser.slice(0, 8)}`);
    expect(await nameOf(regular)).toBe("ops");
    for (const row of builtin) expect(await nameOf(row.id)).toBe(row.name);
    expect(await refusal("member")).toBe(CONSTRAINT);
  });
});
