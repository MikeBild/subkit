import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { workflowsSchedules } from "../../db/schema/index.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { seedPatchableWorkflow } from "../../test-helpers/patch-candidates.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("tools-call-parity");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp tools — catalog characterization", () => {
  test("tools/list includes every named MCP product-tier read tool today", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = new Set(result.tools.map((t) => t.name));

    const expected = [
      "authenticate",
      "match_connector_template_by_url",
      "list_recipes",
      "inspect_recipe",
      "test_connector",
    ];
    for (const name of expected) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("tools/list omits self_healing.scan in the default principal's product mode", () => {
    return suite.connect().then(async (client) => {
      const result = await client.listTools();
      const names = new Set(result.tools.map((t) => t.name));
      expect(names.has("self_healing_scan")).toBe(false);
    });
  });

  test("tools/list entries carry a description and JSON-schema-shaped inputSchema", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const authenticate = result.tools.find((t) => t.name === "authenticate");
    expect(authenticate).toBeDefined();
    expect(typeof authenticate?.description).toBe("string");
    expect((authenticate?.description ?? "").length).toBeGreaterThan(0);
    expect(authenticate?.inputSchema).toBeDefined();
    expect((authenticate!.inputSchema as { type?: string }).type).toBe("object");
  });

  test("tools/list exposes wf.<slug> entries for seeded workflows", async () => {
    await suite.seedWorkflow({
      name: "parity probe",
      slug: "parity-probe",
      input_schema: {
        type: "object",
        properties: { x: { type: "string" } },
      },
      steps: [{ kind: "transform", id: "t", expression: "$input" }],
    });
    const client = await suite.connect();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("wf_parity-probe");
  });
});

describe("mcp tools — call envelope characterization", () => {
  test("get_operational_overview returns the exact REST snapshot", async () => {
    const rest = await fetch(`${suite.http.baseUrl}/v1/operational-overview`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    expect(rest.status).toBe(200);
    const expected = await rest.json();

    const client = await suite.connect();
    const result = await client.callTool({ name: "get_operational_overview", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const snapshot = JSON.parse(content[0]!.text) as unknown;
    expect(snapshot).toEqual(expected);
  });

  test("get_attention returns the same list as GET /v1/attention", async () => {
    const wf = await seedPatchableWorkflow(suite.http.db, suite.http.tenantId, "attn-held");
    await suite.http.db.insert(workflowsSchedules).values({
      tenant_id: suite.http.tenantId,
      workflow_id: wf.workflow_id,
      cron: "0 * * * *",
      admission_hold: {
        reason_code: "execution_authority_required",
        observed_at: new Date(getTestNow()).toISOString(),
      },
    });

    invalidateAttention();
    const rest = await fetch(`${suite.http.baseUrl}/v1/attention`, {
      headers: { authorization: `Bearer ${suite.http.apiKey}` },
    });
    expect(rest.status).toBe(200);
    const expected = (await rest.json()) as { generated_at: string; items: unknown[] };
    expect(expected.items.length).toBeGreaterThan(0);

    invalidateAttention();
    const client = await suite.connect();
    const result = await client.callTool({ name: "get_attention", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const attention = JSON.parse(content[0]!.text) as { generated_at: string };
    expect({ ...attention, generated_at: "" }).toEqual({ ...expected, generated_at: "" });
  });

  test("tools/call match_connector_template_by_url returns the canonical {isError, content:[text]} envelope", async () => {
    const client = await suite.connect();
    const result = await client.callTool({
      name: "match_connector_template_by_url",
      arguments: { url: "https://api.example.test/v1" },
    });
    expect(typeof result.isError).toBeOneOf(["boolean", "undefined"]);
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0]?.type).toBe("text");
    expect(typeof content[0]?.text).toBe("string");
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  test("tools/call an unknown tool returns isError=true (current shape)", async () => {
    const client = await suite.connect();
    let threw = false;
    let isError = false;
    try {
      const result = await client.callTool({
        name: "definitely_not_a_real_tool",
        arguments: {},
      });
      isError = Boolean(result.isError);
    } catch {
      threw = true;
    }
    expect(threw || isError).toBe(true);
  });
});
