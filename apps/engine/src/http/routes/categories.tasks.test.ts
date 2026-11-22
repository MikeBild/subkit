import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { tasks } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { HttpError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";
import { registerCategoryRoutes } from "./categories.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";

const OWNER = "88888888-0000-4000-8000-000000000001";
const COLLEAGUE = "88888888-0000-4000-8000-000000000002";

interface Usage {
  category: string;
  total: number;
  counts: { task: number };
}

function appFor(principal: ResolvedPrincipal) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError((err, c) =>
    c.json({ error: err.message }, err instanceof HttpError ? (err.status as 403) : 500),
  );
  app.use("*", async (c, next) => {
    c.set("db", ctx.db as never);
    c.set("principal", principal);
    await next();
  });
  registerCategoryRoutes(app);
  return app;
}

const member = (id: string, tenant_id: string): ResolvedPrincipal => ({
  provider: "api_key",
  kind: "user",
  id,
  tenant_id,
  roles: ["member"],
});

async function seedTask(tenant_id: string, owner_id: string, category: string): Promise<string> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id,
      name: `Task in ${category}`,
      category,
      category_source: "human",
      description_source: "human",
      owner_id,
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: "a".repeat(64),
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task fixture missing");
  return row.id;
}

async function categories(principal: ResolvedPrincipal): Promise<Usage[]> {
  const res = await appFor(principal).request("/v1/categories");
  expect(res.status).toBe(200);
  return ((await res.json()) as { categories: Usage[] }).categories;
}

function rename(principal: ResolvedPrincipal, from: string, to: string) {
  return appFor(principal).request(`/v1/categories/${from}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      to,
      purpose: null,
      aliases: [],
      expected_source_revision: null,
      expected_target_revision: null,
    }),
  });
}

beforeAll(async () => {
  ctx = await createTestDb("categories_tasks_route");
  tenantA = (await seedTenant(ctx.db, { slug: "categories-tasks-a", display_name: "A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "categories-tasks-b", display_name: "B" })).id;
  await seedTask(tenantA, OWNER, "reports");
  await seedTask(tenantA, COLLEAGUE, "reports");
  await seedTask(tenantA, COLLEAGUE, "reports");
  await seedTask(tenantA, COLLEAGUE, "colleague-only");
  await seedTask(tenantB, OWNER, "reports");
  await seedTask(tenantB, OWNER, "foreign-only");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /v1/categories with tasks", () => {
  test("a member's counts cover own tasks only", async () => {
    const mine = await categories(member(OWNER, tenantA));
    expect(mine.find((usage) => usage.category === "reports")).toMatchObject({
      total: 1,
      counts: { task: 1 },
    });
    expect(mine.map((usage) => usage.category)).not.toContain("colleague-only");
    const theirs = await categories(member(COLLEAGUE, tenantA));
    expect(theirs.find((usage) => usage.category === "reports")?.counts.task).toBe(2);
    expect(theirs.find((usage) => usage.category === "colleague-only")?.counts.task).toBe(1);
  });

  test("an admin's counts cover every task of the tenant and no other tenant's", async () => {
    const all = await categories(adminPrincipal(tenantA));
    expect(all.find((usage) => usage.category === "reports")?.counts.task).toBe(3);
    expect(all.find((usage) => usage.category === "colleague-only")?.counts.task).toBe(1);
    expect(all.map((usage) => usage.category)).not.toContain("foreign-only");
  });

  test("a reader without task:read sees no task counts", async () => {
    const scoped = await categories({ ...adminPrincipal(tenantA), scopes: ["workflow:read"] });
    expect(scoped.every((usage) => usage.counts.task === 0)).toBe(true);
    expect(scoped.map((usage) => usage.category)).not.toContain("colleague-only");
  });
});

describe("POST /v1/categories/{name}/rename with tasks", () => {
  const WRITES = [
    "workflow:write",
    "connector:write",
    "knowledge:write",
    "skill:write",
    "file:write",
  ];

  test("moving tasks needs task:write; a block without tasks does not", async () => {
    const id = await seedTask(tenantA, OWNER, "rename-guarded");
    const limited = { ...adminPrincipal(tenantA), scopes: WRITES };
    expect((await rename(limited, "rename-guarded", "rename-guarded-next")).status).toBe(403);
    const [unmoved] = await ctx.db
      .select({ category: tasks.category })
      .from(tasks)
      .where(and(eq(tasks.tenant_id, tenantA), eq(tasks.id, id)));
    expect(unmoved?.category).toBe("rename-guarded");
    expect((await rename(limited, "foreign-only", "foreign-only-next")).status).not.toBe(403);

    const allowed = await rename(
      { ...adminPrincipal(tenantA), scopes: [...WRITES, "task:write"] },
      "rename-guarded",
      "rename-guarded-next",
    );
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { moved: { task: number } }).moved.task).toBe(1);
    const [moved] = await ctx.db
      .select({ category: tasks.category })
      .from(tasks)
      .where(and(eq(tasks.tenant_id, tenantA), eq(tasks.id, id)));
    expect(moved?.category).toBe("rename-guarded-next");
  });

  test("a rename in one tenant leaves the other tenant's tasks where they are", async () => {
    const [foreign] = await ctx.db
      .select({ category: tasks.category })
      .from(tasks)
      .where(and(eq(tasks.tenant_id, tenantB), eq(tasks.category, "foreign-only")));
    expect(foreign?.category).toBe("foreign-only");
  });
});
