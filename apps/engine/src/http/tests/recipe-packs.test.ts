import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("recipe_packs");
});

afterAll(async () => {
  await ctx.cleanup();
});

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

interface PackEntry {
  template_slug: string | null;
  recipe_slug: string;
  description: string;
  connectors: Array<{
    placeholder: string;
    template: string;
    template_name: string;
    connector_id: string | null;
    connector_name: string | null;
    candidates: Array<{ id: string; slug: string; name: string }>;
  }>;
  sample_input: unknown;
  workflow: { name: string; steps: unknown[] };
}

async function solutions(): Promise<PackEntry[]> {
  const res = await fetch(`${ctx.baseUrl}/v1/recipe-packs/solutions`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { vertical: string; outcome: string; recipes: PackEntry[] };
  expect(body.vertical).toBe("solutions");
  expect(body.outcome.length).toBeGreaterThan(0);
  return body.recipes;
}

async function createdAudit(workflowId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await ctx.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "workflow.created"),
        eq(auditLog.resource_id, workflowId),
      ),
    );
  return row?.metadata as Record<string, unknown> | undefined;
}

describe("GET /v1/recipe-packs/solutions", () => {
  test("lists every solution with its connectors, unbound while the tenant has none", async () => {
    const entries = await solutions();
    expect(entries.map((e) => e.recipe_slug)).toContain("webhook-to-slack");
    const slack = entries.find((e) => e.recipe_slug === "webhook-to-slack");
    expect(slack?.template_slug).toBeNull();
    expect(slack?.connectors).toEqual([
      {
        placeholder: "54000000-0000-4000-8000-000000000001",
        template: "slack",
        template_name: "Slack",
        connector_id: null,
        connector_name: null,
        candidates: [],
      },
    ]);
    expect(slack?.sample_input).toEqual(expect.objectContaining({ level: "error" }));
  });

  test("binds a solution to the tenant's connector of the required template", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/connectors`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "Team Slack",
        slug: "team-slack",
        driver: "http",
        environment: "prod",
        auth_type: "bearer",
        template_slug: "slack",
      }),
    });
    expect(res.status).toBe(201);
    const connector = (await res.json()) as { id: string };
    const slack = (await solutions()).find((e) => e.recipe_slug === "webhook-to-slack");
    expect(slack?.connectors[0]?.connector_id).toBe(connector.id);
    expect(slack?.connectors[0]?.candidates).toEqual([
      { id: connector.id, slug: "team-slack", name: "Team Slack" },
    ]);
    expect(JSON.stringify(slack?.workflow)).toContain(connector.id);
    expect(JSON.stringify(slack?.workflow)).not.toContain("54000000-0000-4000-8000-000000000001");
  });

  test("an unknown vertical is refused", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/recipe-packs/unknown`, { headers: auth() });
    expect(res.status).toBe(400);
  });
});

describe("creating a workflow from a recipe records its origin", () => {
  test("a draft from a solution is audited with source recipe", async () => {
    const entry = (await solutions()).find((e) => e.recipe_slug === "webhook-to-slack");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        definition: { ...entry?.workflow, slug: "webhook-to-slack-draft" },
        recipe: { vertical: "solutions", slug: "webhook-to-slack" },
      }),
    });
    expect(res.status).toBe(201);
    const draft = (await res.json()) as { workflow_id: string; current_version_id: string | null };
    expect(draft.current_version_id).toBeNull();
    expect(await createdAudit(draft.workflow_id)).toEqual(
      expect.objectContaining({
        source: "recipe",
        recipe_vertical: "solutions",
        recipe_slug: "webhook-to-slack",
        kind: "draft",
      }),
    );
  });

  test("a saved workflow from a solution is audited with source recipe", async () => {
    const entry = (await solutions()).find((e) => e.recipe_slug === "webhook-to-slack");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        ...entry?.workflow,
        slug: "webhook-to-slack-saved",
        recipe: { vertical: "solutions", slug: "webhook-to-slack" },
      }),
    });
    expect(res.status).toBe(201);
    const workflow = (await res.json()) as { id: string };
    expect(await createdAudit(workflow.id)).toEqual(
      expect.objectContaining({ source: "recipe", recipe_slug: "webhook-to-slack", version: 1 }),
    );
  });

  test("an origin that names no shipped recipe is refused", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        definition: {
          name: "made-up",
          steps: [{ id: "start", kind: "transform", expression: "return input;" }],
        },
        recipe: { vertical: "solutions", slug: "made-up" },
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      "recipe_unknown",
    );
  });

  test("an origin whose definition was not built from that recipe is refused", async () => {
    const entry = (await solutions()).find((e) => e.recipe_slug === "webhook-to-slack");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        definition: {
          ...entry?.workflow,
          slug: "webhook-to-slack-forged",
          steps: [{ id: "start", kind: "transform", expression: "return input;" }],
        },
        recipe: { vertical: "solutions", slug: "webhook-to-slack" },
      }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      "recipe_mismatch",
    );
  });

  test("an origin in a vertical that does not exist is refused", async () => {
    const entry = (await solutions()).find((e) => e.recipe_slug === "webhook-to-slack");
    const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        ...entry?.workflow,
        slug: "webhook-to-slack-other-pack",
        recipe: { vertical: "made-up", slug: "webhook-to-slack" },
      }),
    });
    expect(res.status).toBe(422);
  });
});
