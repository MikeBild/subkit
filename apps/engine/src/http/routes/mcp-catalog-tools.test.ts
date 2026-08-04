// `GET /v1/mcp/tools` must answer with the catalog the MCP surface actually
// publishes — not with a copy of it, and not with a different palette.
//
// It used to serve a seven-name constant: no principal, no database,
// `input_shape: null`, the same answer for every caller in every tenant.
// Measured against production, that constant and `tools/list` for the SAME
// principal shared not one name — 7 against 107 — because those seven were the
// converse loop's `draft_write` intents, which the MCP surface omits by design.
// The route was not stale; it was answering a different question under the
// catalog's name, beside two siblings that both read live data.
//
// The invariant below is the only thing that keeps the fix true. A route that
// rebuilds the catalog its own way drifts the moment the real one changes, and
// that drift is invisible from the outside: both endpoints keep returning a
// plausible list of tool names. So the assertion is SET EQUALITY against the
// same function `tools/list` calls, not a count and not a spot check.

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
    // Set equality, both directions. A superset would advertise tools the MCP
    // surface refuses; a subset would hide ones it serves.
    expect(names).toEqual(expected);
  });

  test("the retired draft_write intents are gone", async () => {
    const { names } = await fetchRouteNames();
    // These seven were the entire old response. They are `draft_write` (or loop
    // intents with no tool definition at all) and the MCP catalog omits them on
    // purpose, so their reappearance means the constant came back.
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
    // `input_shape` was `null` on every entry — the one field that was never
    // populated, and the one a caller needs to build a request.
    const withSchema = items.filter((i) => i.input_shape !== null);
    expect(withSchema.length).toBeGreaterThan(0);
    const shape = withSchema[0]?.input_shape as { type?: unknown };
    expect(shape.type).toBe("object");
  });
});
