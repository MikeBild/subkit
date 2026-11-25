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
  install_inputs?: string[];
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
  test("exposes install inputs for the CLI to pin the analytics boundary (#519)", async () => {
    const entries = await solutions();
    const analytics = entries.find((entry) => entry.recipe_slug === "daily-analytics-report");
    expect(analytics).toBeDefined();
    expect(analytics?.install_inputs).toEqual(["property_id"]);
  });

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

describe("install inputs a recipe pins into its request paths (#519)", () => {
  const analyticsDraft = async (slug: string, inputs?: Record<string, unknown>) => {
    const entry = (await solutions()).find((e) => e.recipe_slug === "daily-analytics-report");
    return fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        definition: { ...entry?.workflow, slug },
        recipe: {
          vertical: "solutions",
          slug: "daily-analytics-report",
          ...(inputs ? { inputs } : {}),
        },
      }),
    });
  };
  const paths = (draft: { definition: { steps: Array<{ id: string; path?: string }> } }) =>
    draft.definition.steps.flatMap((step) =>
      step.id === "totals" || step.id === "top_pages" ? [step.path] : [],
    );

  test("the property id given at install is written into both report paths", async () => {
    const res = await analyticsDraft("daily-analytics-pinned", {
      property_id: "123456789",
      recipient: "team@example.com",
    });
    expect(res.status).toBe(201);
    expect(paths(await res.json())).toEqual([
      "/v1beta/properties/123456789:runReport",
      "/v1beta/properties/123456789:runReport",
    ]);
  });

  test("without install inputs the placeholder paths are saved unchanged", async () => {
    const res = await analyticsDraft("daily-analytics-unpinned");
    expect(res.status).toBe(201);
    expect(paths(await res.json())).toEqual([
      "/v1beta/properties/${input.property_id}:runReport",
      "/v1beta/properties/${input.property_id}:runReport",
    ]);
  });

  test("a property id that is not one plain path segment is refused", async () => {
    const res = await analyticsDraft("daily-analytics-forged", { property_id: "1/../2" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      "recipe_input_invalid",
    );
  });
});

describe("the paid checkout solution asks for its sender at install (#590)", () => {
  const paidRecipe = { vertical: "solutions", slug: "payment-grants-access" };
  const paidCheckout = async () => {
    const { createConnector } = await import("../../connectors/service.ts");
    const entry = (await solutions()).find((e) => e.recipe_slug === "payment-grants-access");
    if (!entry) throw new Error("payment-grants-access missing from the solutions pack");
    const mapping = new Map<string, string>();
    for (const binding of entry.connectors) {
      const connector = await createConnector(
        {
          tenant_id: ctx.tenantId,
          actor_id: null,
          input: {
            name: binding.template,
            slug: `paid-${binding.template}-${mapping.size}`,
            driver: "http",
            environment: "prod",
            auth_type: "none",
            template_slug: binding.template,
            base_url: "https://access.example.com",
          },
        },
        ctx.db,
      );
      mapping.set(binding.connector_id ?? binding.placeholder, connector.id);
    }
    const text = [...mapping].reduce(
      (json, [from, to]) => json.replaceAll(from, to),
      JSON.stringify(entry.workflow),
    );
    return { entry, definition: JSON.parse(text) as Record<string, unknown> };
  };
  const ownBinding = async (workflowId: string) => {
    const { webhooksInbound } = await import("../../db/schema/index.ts");
    const [hook] = await ctx.db
      .select()
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, ctx.tenantId),
          eq(webhooksInbound.workflow_id, workflowId),
        ),
      );
    return hook;
  };
  const welcomeDelivery = (definition: { steps: Array<Record<string, unknown>> }) =>
    definition.steps.find((step) => step.id === "send_welcome")?.transactional_delivery;
  const post = (path: string, body: unknown) =>
    fetch(`${ctx.baseUrl}${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body) });

  test("the pack lists the sender as the install input", async () => {
    const { entry } = await paidCheckout();
    expect(entry.install_inputs).toEqual(["sender"]);
  });

  test("an install without the sender is refused for workflows and drafts", async () => {
    const { definition } = await paidCheckout();
    const refusals = [
      await post("/v1/workflows", { ...definition, slug: "paid-no-sender", recipe: paidRecipe }),
      await post("/v1/workflows/drafts", {
        definition: { ...definition, slug: "paid-no-sender-draft" },
        recipe: paidRecipe,
      }),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(422);
      expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
        "recipe_input_missing",
      );
    }
  });

  test("an install with the sender pins it and binds the welcome mail to its own Stripe binding", async () => {
    const { definition } = await paidCheckout();
    const res = await post("/v1/workflows", {
      ...definition,
      slug: "paid-installed",
      recipe: { ...paidRecipe, inputs: { sender: "owner@example.com" } },
    });
    expect(res.status).toBe(201);
    const workflow = (await res.json()) as {
      id: string;
      definition: { steps: Array<Record<string, unknown>> };
    };
    const hook = await ownBinding(workflow.id);
    expect({ verifier: hook?.verifier, config: hook?.native_verifier_config }).toEqual({
      verifier: "stripe",
      config: { source: "stripe", events: ["checkout.session.completed"] },
    });
    expect(welcomeDelivery(workflow.definition)).toMatchObject({
      webhook_id: hook?.id,
      from: "owner@example.com",
    });
    expect(JSON.stringify(workflow.definition)).not.toContain("install-input.invalid");
  });

  test("a draft install binds its own Stripe binding before review", async () => {
    const { definition } = await paidCheckout();
    const res = await post("/v1/workflows/drafts", {
      definition: { ...definition, slug: "paid-installed-draft" },
      recipe: { ...paidRecipe, inputs: { sender: "owner@example.com" } },
    });
    expect(res.status).toBe(201);
    const draft = (await res.json()) as {
      workflow_id: string;
      current_version_id: string | null;
      definition: { steps: Array<Record<string, unknown>> };
    };
    const hook = await ownBinding(draft.workflow_id);
    expect({ verifier: hook?.verifier, current: draft.current_version_id }).toEqual({
      verifier: "stripe",
      current: null,
    });
    expect(welcomeDelivery(draft.definition)).toMatchObject({
      webhook_id: hook?.id,
      from: "owner@example.com",
    });
  });
});
