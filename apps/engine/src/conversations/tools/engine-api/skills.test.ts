import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createSkill } from "../../../skills/service.ts";
import type { ToolContext } from "../index.ts";
import { listAllSkillsTool } from "./skills.ts";

type Page = {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  skills: Array<{ title: string }>;
};

describe("list_all_skills — paged listing", () => {
  let testDb: TestDb;
  let tenantId = "";
  let otherTenantId = "";

  function ctxFor(tenant_id: string): ToolContext {
    return { db: testDb.db, tenant_id } as unknown as ToolContext;
  }

  async function page(args: Record<string, unknown>): Promise<Page> {
    const result = await listAllSkillsTool.execute(ctxFor(tenantId), args);
    if (!result.ok) throw new Error("list_all_skills failed");
    return result.data as Page;
  }

  beforeAll(async () => {
    testDb = await createTestDb("list-all-skills-paging");
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "las-tenant", display_name: "Paging Tenant" })
      .returning();
    const [other] = await testDb.db
      .insert(tenants)
      .values({ slug: "las-other", display_name: "Other Tenant" })
      .returning();
    if (!tenant || !other) throw new Error("tenant seed failed");
    tenantId = tenant.id;
    otherTenantId = other.id;
    for (const n of [1, 2, 3, 4, 5]) {
      await createSkill(
        { tenant_id: tenantId, input: { scope: "global", title: `Skill ${n}`, body: `Body ${n}` } },
        testDb.db,
      );
    }
    await createSkill(
      { tenant_id: otherTenantId, input: { scope: "global", title: "Foreign", body: "Other" } },
      testDb.db,
    );
  });

  afterAll(async () => {
    await testDb?.cleanup();
  });

  test("returns the first page with the tenant total and the next offset", async () => {
    const first = await page({ limit: 2 });
    expect(first).toMatchObject({ total: 5, limit: 2, offset: 0, has_more: true, next_offset: 2 });
    expect(first.skills.map((s) => s.title)).toEqual(["Skill 1", "Skill 2"]);
  });

  test("pages through to the end without overlap", async () => {
    const second = await page({ limit: 2, offset: 2 });
    expect(second.skills.map((s) => s.title)).toEqual(["Skill 3", "Skill 4"]);
    expect(second.next_offset).toBe(4);
    const last = await page({ limit: 2, offset: 4 });
    expect(last.skills.map((s) => s.title)).toEqual(["Skill 5"]);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeUndefined();
  });

  test("defaults to a page of fifty and rejects a limit above two hundred", async () => {
    const all = await page({});
    expect(all).toMatchObject({ total: 5, limit: 50, offset: 0, has_more: false });
    expect(all.skills.some((s) => s.title === "Foreign")).toBe(false);
    expect(listAllSkillsTool.inputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});
