// DB-backed skill gate tests.
//
// Verifies that `requiredSkillForTenant` and `filterBySkillGateForTenant`
// read `skills.gates_tools` correctly and that the 60s cache honours
// `resetGateCache`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skills, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import {
  filterBySkillGate,
  filterBySkillGateForTenant,
  requiredSkillFor,
  requiredSkillForTenant,
  resetGateCache,
  SKILL_GATED_TOOLS,
} from "../gated.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("gated_from_db");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-gate", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedSkill(slug: string, gates_tools: string[]): Promise<void> {
  await ctx.db.insert(skills).values({
    tenant_id,
    slug,
    scope: "global",
    title: slug,
    body: `Body for ${slug}`,
    lifecycle: "active",
    source: "template",
    gates_tools,
  });
}

describe("hardcoded baseline — preserved", () => {
  test("approve_patch_candidate is gated by self-healing by default", () => {
    expect(requiredSkillFor("approve_patch_candidate")).toBe("self-healing");
  });

  test("non-gated tools return undefined", () => {
    expect(requiredSkillFor("list_connectors")).toBeUndefined();
  });

  test("SKILL_GATED_TOOLS constant is not empty", () => {
    expect(Object.keys(SKILL_GATED_TOOLS).length).toBeGreaterThan(0);
  });

  test("filterBySkillGate — gated tool hidden without skill, visible with", () => {
    const tools = [{ name: "list_connectors" }, { name: "approve_patch_candidate" }];
    const hidden = filterBySkillGate(tools, []);
    expect(hidden.map((t) => t.name)).toEqual(["list_connectors"]);
    const visible = filterBySkillGate(tools, ["self-healing"]);
    expect(visible.map((t) => t.name)).toEqual(["list_connectors", "approve_patch_candidate"]);
  });
});

describe("DB-backed gates — tenant layer", () => {
  test("skill with gates_tools gates the listed tool", async () => {
    resetGateCache();
    await seedSkill("db-gate-a", ["custom_write_tool"]);
    const gateSlug = await requiredSkillForTenant("custom_write_tool", tenant_id, ctx.db);
    expect(gateSlug).toBe("db-gate-a");
  });

  test("filterBySkillGateForTenant hides DB-gated tool without skill", async () => {
    resetGateCache();
    const tools = [{ name: "custom_write_tool" }, { name: "list_connectors" }];
    const hidden = await filterBySkillGateForTenant(tools, [], tenant_id, ctx.db);
    expect(hidden.map((t) => t.name)).toEqual(["list_connectors"]);
    const visible = await filterBySkillGateForTenant(tools, ["db-gate-a"], tenant_id, ctx.db);
    expect(visible.map((t) => t.name)).toEqual(["custom_write_tool", "list_connectors"]);
  });

  test("DB gate merges with baseline — approve_patch_candidate still gated", async () => {
    resetGateCache();
    const result = await requiredSkillForTenant("approve_patch_candidate", tenant_id, ctx.db);
    expect(result).toBe("self-healing");
  });

  test("cache reflects DB updates only after resetGateCache", async () => {
    resetGateCache();
    // First call seeds the cache
    const before = await requiredSkillForTenant("late_tool", tenant_id, ctx.db);
    expect(before).toBeUndefined();
    // Add a seed that gates `late_tool`
    await seedSkill("late-gate", ["late_tool"]);
    // Cached result is still the old one
    const stillCached = await requiredSkillForTenant("late_tool", tenant_id, ctx.db);
    expect(stillCached).toBeUndefined();
    // After reset, new value picked up
    resetGateCache(tenant_id);
    const fresh = await requiredSkillForTenant("late_tool", tenant_id, ctx.db);
    expect(fresh).toBe("late-gate");
  });

  test("deterministic winner when two skills gate the same tool", async () => {
    resetGateCache();
    await seedSkill("alpha-gate", ["shared_tool"]);
    await seedSkill("zeta-gate", ["shared_tool"]);
    const gateSlug = await requiredSkillForTenant("shared_tool", tenant_id, ctx.db);
    // Sorted by slug, 'alpha-gate' wins over 'zeta-gate'.
    expect(gateSlug).toBe("alpha-gate");
  });
});
