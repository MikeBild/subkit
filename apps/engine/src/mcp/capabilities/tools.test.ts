import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflows } from "../../db/schema/index.ts";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import { journeyFetch } from "../../tests/journeys/setup.ts";
import { connect, ctx, mockBase, setupMcpTools, toolWfSlug } from "./tests/tools-fixtures.ts";

setupMcpTools();

describe("MCP tools/list — wf_<slug> catalog (T22)", () => {
  test("an advertised unprefixed conversation tool reaches its handler in authoring mode", async () => {
    await runWithTestEnv({ SUBKIT_MCP_MODE: "authoring" }, async () => {
      const client = await connect();
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toContain("suggest_related_conversations");
        const result = await client.callTool({
          name: "suggest_related_conversations",
          arguments: { message: "a topic with no prior conversation" },
        });
        expect(result.isError).toBe(false);
        expect(JSON.stringify(result)).not.toContain("unknown tool");
      } finally {
        await client.close();
      }
    });
  });

  test("tools/list over MCP returns the seeded wf_<slug> tool", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain(`wf_${toolWfSlug}`);
    } finally {
      await client.close();
    }
  });

  test("wf_<slug> tool has name, description, and inputSchema", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === `wf_${toolWfSlug}`);
      expect(tool).toBeDefined();
      expect(typeof tool!.name).toBe("string");
      expect(typeof tool!.description).toBe("string");
      expect(typeof tool!.inputSchema).toBe("object");
    } finally {
      await client.close();
    }
  });

  test("conversation tools are present alongside wf_ entries; draft_write is hidden on MCP", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = new Set(list.tools.map((t) => t.name));
      expect(names.has("list_recipes")).toBe(true);
      expect(names.has("test_connector")).toBe(true);
      expect(names.has("edit_workflow_patch")).toBe(false);
      expect(names.has("save_workflow_draft")).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("every tool advertises MCP annotations; reads/writes/runs are classified", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const byName = new Map(list.tools.map((t) => [t.name, t]));

      for (const t of list.tools) expect(t.annotations).toBeDefined();

      expect(byName.get("list_recipes")?.annotations?.readOnlyHint).toBe(true);

      const wf = byName.get(`wf_${toolWfSlug}`);
      expect(wf?.annotations?.readOnlyHint).toBe(false);
      expect(wf?.annotations?.openWorldHint).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("REST GET /v1/mcp/tools returns exactly what tools/list returns", async () => {
    const res = await journeyFetch(ctx, "/v1/mcp/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    const restNames = body.items.map((t) => t.name).sort();
    expect(restNames.length).toBeGreaterThan(0);

    const client = await connect();
    try {
      const list = await client.listTools();
      expect(restNames).toEqual(list.tools.map((t) => t.name).sort());
    } finally {
      await client.close();
    }
  });

  test("workflow with is_tool=false is NOT surfaced in tools/list", async () => {
    const noToolSlug = "non-tool-catalog-wf";
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Non Tool WF",
        slug: noToolSlug,
        steps: [{ kind: "request", id: "s1", url: `${mockBase}` }],
      }),
    });
    const noToolBody = (await createRes.json()) as { id: string };
    await ctx.db.update(workflows).set({ is_tool: false }).where(eq(workflows.id, noToolBody.id));

    const client = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).not.toContain(`wf_${noToolSlug}`);
    } finally {
      await client.close();
    }
  });
});

describe("MCP tools/call — run_workflow missing required input (W4.5 anti-spiral)", () => {
  test("returns a single terminal needs_input envelope naming the missing field", async () => {
    const slug = "needs-input-city-wf";
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Needs Input City WF",
        slug,
        steps: [
          {
            kind: "request",
            id: "probe",
            method: "GET",
            url: `${mockBase}/test?city=\${input.city}`,
          },
        ],
      }),
    });
    expect(createRes.status).toBeLessThan(300);

    const client = await connect();
    try {
      const result = await client.callTool({
        name: "run_workflow",
        arguments: { workflow: slug, environment: "dev" },
      });
      expect(result.isError).toBeFalsy();
      const textBlocks = (result.content as Array<{ type: string; text?: string }>).filter(
        (b) => b.type === "text",
      );
      expect(textBlocks.length).toBe(1);
      const body = JSON.parse(textBlocks[0]!.text!) as {
        status: string;
        error_code: string;
        message: string;
        missing_fields: string[];
        fields: Array<{ name: string }>;
      };
      expect(body.status).toBe("needs_input");
      expect(body.error_code).toBe("missing_input");
      expect(body.missing_fields).toContain("city");
      expect(body.message).toContain("city");
      expect(body.fields.map((f) => f.name)).toContain("city");
      expect(body.status).not.toBe("awaiting_input");
      expect(textBlocks[0]!.text!).not.toContain("elicitation_id");
    } finally {
      await client.close();
    }
  });
});

test("run_workflow keeps tolerated failures visible without falsely claiming clean verification", async () => {
  const slug = "continued-failure-report";
  const created = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Continued failure report",
      slug,
      steps: [
        {
          kind: "transform",
          id: "broken",
          language: "javascript",
          expression: 'throw new Error("missing report source");',
          on_error: "continue",
        },
        {
          kind: "transform",
          id: "done",
          language: "javascript",
          expression: "return { finished: true };",
        },
      ],
    }),
  });
  expect(created.status).toBeLessThan(300);
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "run_workflow",
      arguments: {
        workflow: slug,
        environment: "dev",
        execute_writes: false,
      },
    });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    const body = JSON.parse(blocks.find((b) => b.type === "text")?.text ?? "{}");
    expect(result.isError).toBeFalsy();
    expect(body.status).toBe("succeeded");
    expect(body.requires_repair).toBe(false);
    expect(body.diagnosis_available).toBe(true);
    expect(
      body.summary.checkpoints.find((c: { key: string }) => c.key === "workflow_validated").summary,
    ).toContain("completed with warnings");
  } finally {
    await client.close();
  }
});

test("run_workflow accepts omitted and empty input when declared fields are optional", async () => {
  const slug = "optional-input-report";
  const created = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Optional input report",
      slug,
      input_schema: { type: "object", properties: { runId: { type: "string" } } },
      steps: [{ kind: "request", id: "probe", method: "GET", url: `${mockBase}/test` }],
    }),
  });
  expect(created.status).toBeLessThan(300);
  const client = await connect();
  try {
    for (const input of [undefined, {}]) {
      const result = await client.callTool({
        name: "run_workflow",
        arguments: {
          workflow: slug,
          environment: "dev",
          execute_writes: false,
          ...(input ? { input } : {}),
        },
      });
      expect(result.isError).toBeFalsy();
      const blocks = result.content as Array<{ type: string; text?: string }>;
      const body = JSON.parse(blocks.find((b) => b.type === "text")?.text ?? "{}");
      expect(body.status).toBe("succeeded");
      expect(body.error_code).toBeUndefined();
    }
  } finally {
    await client.close();
  }
});

test("MCP omits provider-incompatible workflow aliases and keeps generic execution", async () => {
  const schema = {
    type: "object",
    properties: { choice: { type: "string" } },
    oneOf: [
      { properties: { choice: { const: "a" } }, required: ["choice"] },
      { properties: { choice: { const: "b" } }, required: ["choice"] },
    ],
    additionalProperties: false,
  };
  const response = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Discriminated input",
      slug: "discriminated-input",
      input_schema: schema,
      steps: [{ kind: "request", id: "probe", method: "GET", url: `${mockBase}/test` }],
    }),
  });
  expect(response.status).toBe(201);
  const workflow = (await response.json()) as { id: string };
  const client = await connect();
  try {
    const names = (await client.listTools()).tools.map((entry) => entry.name);
    expect(names).not.toContain("wf_discriminated-input");
    expect(names).toContain("run_workflow");
    const saved = (await (await journeyFetch(ctx, `/v1/workflows/${workflow.id}`)).json()) as {
      input_schema: unknown;
    };
    expect(saved.input_schema).toEqual(schema);
  } finally {
    await client.close();
  }
});
