import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { assembleCatalog, listWorkflowTools, resolveMcpMode } from "../../mcp/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("mcp-catalog-tools");
}, 90_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function fetchRouteNames(): Promise<{
  names: string[];
  items: Array<{ name: string; description: string; input_shape: unknown }>;
}> {
  const res = await fetch(`${ctx.baseUrl}/v1/mcp/tools`, {
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items: Array<{ name: string; description: string; input_shape: unknown }>;
  };
  return { names: body.items.map((i) => i.name).sort(), items: body.items };
}

describe("GET /v1/mcp/tools", () => {
  test("returns exactly the catalog assembled for this principal", async () => {
    const principal = {
      id: ctx.userId,
      tenant_id: ctx.tenantId,
      kind: "user" as const,
      scopes: ["*"],
    } as unknown as Parameters<typeof resolveMcpMode>[0];

    const expected = assembleCatalog({
      principal,
      mode: resolveMcpMode(principal),
      readOnly: false,
      fullPalette: await listWorkflowTools({ db: ctx.db, principal }),
    })
      .map((t) => t.name)
      .sort();

    const { names } = await fetchRouteNames();
    expect(names).toEqual(expected);
  });

  test("the retired draft_write intents are gone", async () => {
    const { names } = await fetchRouteNames();
    for (const retired of [
      "author_workflow",
      "edit_workflow_patch",
      "dry_run_workflow",
      "dry_run_step",
      "validate_draft",
      "request_human_approval",
      "save_workflow_draft",
    ]) {
      expect(names).not.toContain(retired);
    }
  });

  test("a product-bound alias stays out of a non-product listing without a schema warning", async () => {
    const slug = "mcp-product-round";
    const [wf] = await ctx.db
      .insert(workflows)
      .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "active", is_tool: true })
      .returning({ id: workflows.id });
    if (!wf) throw new Error("workflow seed failed");
    try {
      const [version] = await ctx.db
        .insert(workflowVersions)
        .values({
          tenant_id: ctx.tenantId,
          workflow_id: wf.id,
          version: 1,
          dag: {
            name: slug,
            slug,
            product_id: "tekit",
            required_caller_kind: "user",
            execution_privacy: "sensitive",
            input_schema: {
              type: "object",
              properties: { purpose: { type: "string" } },
              required: ["purpose"],
              additionalProperties: false,
              oneOf: [
                { properties: { purpose: { const: "round" } } },
                { properties: { purpose: { const: "classify" } } },
              ],
            },
            steps: [{ id: "s1", kind: "request", url: "https://example.test/round" }],
          },
        })
        .returning({ id: workflowVersions.id });
      if (!version) throw new Error("version seed failed");
      await ctx.db
        .update(workflows)
        .set({ current_version_id: version.id })
        .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));

      const principal = {
        provider: "test",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        kind: "user" as const,
        roles: ["admin"],
      };
      const warnSpy = spyOn(logger, "warn");
      try {
        const listed = await listWorkflowTools({ db: ctx.db, principal });
        expect(listed.map((entry) => entry.name)).not.toContain(`wf_${slug}`);
        const schemaWarns = warnSpy.mock.calls.filter(
          ([entry]) => (entry as { action?: string }).action === "tool.schema_incompatible",
        );
        expect(schemaWarns).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
      const { names } = await fetchRouteNames();
      expect(names).not.toContain(`wf_${slug}`);
    } finally {
      await ctx.db
        .update(workflows)
        .set({ current_version_id: null })
        .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));
      await ctx.db
        .delete(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, ctx.tenantId),
            eq(workflowVersions.workflow_id, wf.id),
          ),
        );
      await ctx.db
        .delete(workflows)
        .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));
    }
  });

  test("input_shape carries the declared schema instead of null", async () => {
    const { items } = await fetchRouteNames();
    expect(items.length).toBeGreaterThan(0);
    const withSchema = items.filter((i) => i.input_shape !== null);
    expect(withSchema.length).toBeGreaterThan(0);
    const shape = withSchema[0]?.input_shape as { type?: unknown };
    expect(shape.type).toBe("object");
  });
});
