import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { skills, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";

let testDb: TestDb;
let tenantId: string;

async function seed(title: string, tags: string[]): Promise<string> {
  const [row] = await testDb.db
    .insert(skills)
    .values({
      tenant_id: tenantId,
      scope: "global",
      title,
      body: "b",
      lifecycle: "active",
      tags,
    })
    .returning({ id: skills.id });
  if (!row) throw new Error("seed skill failed");
  return row.id;
}

async function conventionsOf(id: string) {
  const [row] = await testDb.db
    .select({ rules: skills.rules, domains: skills.domains })
    .from(skills)
    .where(eq(skills.id, id));
  return row;
}

beforeAll(async () => {
  testDb = await createTestDb("skill_conventions_migration");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-skill-conventions", display_name: "Skill conventions" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("skill conventions", () => {
  test("a new skill starts with empty rules and domains", async () => {
    const untagged = await seed("untagged", ["ops"]);
    expect(await conventionsOf(untagged)).toEqual({ rules: [], domains: [] });
  });

  test("rejects rules and domains that are not arrays", async () => {
    const id = await seed("checked", []);
    const outcome = (statement: ReturnType<typeof sql>) =>
      testDb.db.execute(statement).then(
        () => "accepted",
        () => "rejected",
      );
    expect(await outcome(sql`UPDATE skills SET rules = '{}'::jsonb WHERE id = ${id}`)).toBe(
      "rejected",
    );
    expect(
      await outcome(sql`UPDATE skills SET domains = '"billing"'::jsonb WHERE id = ${id}`),
    ).toBe("rejected");
  });
});
