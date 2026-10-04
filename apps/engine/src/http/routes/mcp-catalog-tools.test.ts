import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

  test("input_shape carries the declared schema instead of null", async () => {
    const { items } = await fetchRouteNames();
    expect(items.length).toBeGreaterThan(0);
    const withSchema = items.filter((i) => i.input_shape !== null);
    expect(withSchema.length).toBeGreaterThan(0);
    const shape = withSchema[0]?.input_shape as { type?: unknown };
    expect(shape.type).toBe("object");
  });
});
