import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { tasks } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { HttpError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";
import { registerAgentBriefingRoutes } from "./agent-briefing.ts";

let ctx: TestDb;
let tenantA = "";
let tenantB = "";
const ids: Record<string, string> = {};

const OWNER = "99999999-0000-4000-8000-000000000001";
const COLLEAGUE = "99999999-0000-4000-8000-000000000002";

interface Briefing {
  markdown: string;
  tasks: string[];
  tasks_omitted: number;
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
  registerAgentBriefingRoutes(app);
  return app;
}

const person = (id: string, role: "member" | "enduser"): ResolvedPrincipal => ({
  provider: "api_key",
  kind: "user",
  id,
  tenant_id: tenantA,
  roles: [role],
});

async function seedTask(key: string, tenant_id: string, owner_id: string): Promise<void> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id,
      name: key,
      description: `About ${key}`,
      category: "reports",
      category_source: "human",
      description_source: "human",
      owner_id,
      goal: `Confidential goal of ${key}`,
      done_when: "The report is in the inbox",
      plan: { title: key, goal: "Goal", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: "a".repeat(64),
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task fixture missing");
  ids[key] = row.id;
}

async function briefing(principal: ResolvedPrincipal): Promise<Briefing> {
  const res = await appFor(principal).request("/v1/agent/briefing?domains=reports");
  expect(res.status).toBe(200);
  return (await res.json()) as Briefing;
}

beforeAll(async () => {
  ctx = await createTestDb("agent_briefing_tasks_route");
  tenantA = (await seedTenant(ctx.db, { slug: "briefing-route-a", display_name: "A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "briefing-route-b", display_name: "B" })).id;
  await seedTask("Own report", tenantA, OWNER);
  await seedTask("Colleague report", tenantA, COLLEAGUE);
  await seedTask("Foreign report", tenantB, OWNER);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /v1/agent/briefing with tasks", () => {
  test("the owner sees own tasks by name and id, never the goal", async () => {
    const mine = await briefing(person(OWNER, "member"));
    expect(mine.tasks).toEqual([ids["Own report"] as string]);
    expect(mine.tasks_omitted).toBe(0);
    expect(mine.markdown).toContain(
      `- **Own report** (\`${ids["Own report"]}\`, reports) — About Own report`,
    );
    expect(mine.markdown).not.toContain("Colleague report");
    expect(mine.markdown).not.toContain("Foreign report");
    expect(mine.markdown).not.toContain("Confidential goal");
  });

  test("another member does not see it", async () => {
    const theirs = await briefing(person(COLLEAGUE, "member"));
    expect(theirs.tasks).toEqual([ids["Colleague report"] as string]);
    expect(theirs.markdown).not.toContain("Own report");
  });

  test("an admin sees every task of the tenant and none of another tenant", async () => {
    const all = await briefing(adminPrincipal(tenantA));
    expect(all.tasks).toEqual([ids["Colleague report"] as string, ids["Own report"] as string]);
    expect(all.markdown).not.toContain("Foreign report");
  });

  test("an enduser and a key without task:read get no tasks, also as the owner", async () => {
    const scoped = await briefing({ ...person(OWNER, "member"), scopes: ["skill:read"] });
    expect(scoped.tasks).toEqual([]);
    expect(scoped.tasks_omitted).toBe(0);
    expect(scoped.markdown).not.toContain("## Tasks");
    const enduser = await briefing(person(OWNER, "enduser"));
    expect(enduser.tasks).toEqual([]);
    expect(enduser.markdown).not.toContain("Own report");
  });
});
