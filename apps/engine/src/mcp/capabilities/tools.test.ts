import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, count, eq, sql } from "drizzle-orm";
import {
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
} from "../../tests/journeys/setup.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let toolWfSlug: string;
let toolWfId: string;
let boundaryFixture = 0;
let writes = 0;

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  const client = new Client({ name: "subkit-tools-test", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("mcp-tools-catalog");

  mock = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/bounded-write") writes++;
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  toolWfSlug = "catalog-regression-wf";
  const createRes = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Catalog Regression WF",
      slug: toolWfSlug,
      steps: [{ kind: "request", id: "probe", method: "GET", url: `${mockBase}/test` }],
    }),
  });
  const wfBody = (await createRes.json()) as { id: string };
  toolWfId = wfBody.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("MCP tools/list — wf_<slug> catalog (T22)", () => {
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

describe("MCP tools/call — wf_<slug> end-to-end (T7)", () => {
  function body(result: unknown) {
    const text = CallToolResultSchema.parse(result).content.find(
      (item) => item.type === "text",
    )?.text;
    expect(text).toBeString();
    return JSON.parse(text!) as Record<string, unknown>;
  }
  async function boundedFixture(
    state: "none" | "active" | "expired" | "revoked" = "none",
    outputSchema = false,
  ) {
    const slug = `mcp-boundary-${++boundaryFixture}`;
    const response = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: slug,
        slug,
        ...(outputSchema
          ? {
              output_schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
              },
            }
          : {}),
        steps: [
          {
            kind: "request",
            id: "send",
            method: "POST",
            url: `${mockBase}/bounded-write`,
            side_effects: "read",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    const { id } = (await response.json()) as { id: string };
    const [workflow] = await ctx.db
      .update(workflows)
      .set({ lifecycle: "active" })
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, id)))
      .returning();
    if (!workflow?.current_version_id) throw new Error("missing exact workflow fixture version");
    if (state === "none") return { slug, id, authorityId: null };
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: ctx.tenantId,
        workflow_id: id,
        workflow_version_id: workflow.current_version_id,
        execution_environment: "dev",
      },
      ctx.db,
    );
    expect(preview.eligible_for_repeated_runs).toBe(true);
    const [authority] = await ctx.db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: id,
        workflow_version_id: workflow.current_version_id,
        effect_manifest_digest: preview.digest,
        effect_manifest: { ...preview.manifest },
        target_constraints: {
          targets: preview.manifest.effects.flatMap((effect) =>
            effect.target ? [effect.target] : [],
          ),
        },
        execution_environment: "dev",
        created_by: ctx.userId,
        max_runs: 2,
        valid_from: sql`clock_timestamp() - interval '2 hours'`,
        valid_until:
          state === "expired"
            ? sql`clock_timestamp() - interval '1 hour'`
            : sql`clock_timestamp() + interval '1 hour'`,
        ...(state === "revoked"
          ? { revoked_at: sql`clock_timestamp()`, revoked_by: ctx.userId }
          : {}),
      })
      .returning();
    if (!authority) throw new Error("missing authority fixture");
    return { slug, id, authorityId: authority.id };
  }

  test("native MCP calls cannot turn a read-labelled POST into unapproved live execution", async () => {
    const fixture = await boundedFixture();
    const before = writes;
    const client = await connect();
    try {
      const result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
      expect(body(result)).toMatchObject({
        live_execution_authorized: false,
        status: "preparation",
      });
      expect(writes).toBe(before);
    } finally {
      await client.close();
    }
  });

  test("two authorized MCP runs dispatch automatically; the exhausted third only prepares", async () => {
    const fixture = await boundedFixture("active");
    const before = writes;
    const client = await connect();
    try {
      for (let run = 0; run < 2; run++) {
        const result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(body(result).status).not.toBe("preparation");
      }
      expect(writes).toBe(before + 2);
      const exhausted = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
      expect(body(exhausted)).toMatchObject({
        live_execution_authorized: false,
        status: "preparation",
      });
      expect(writes).toBe(before + 2);
      const [authority] = await ctx.db
        .select()
        .from(workflowExecutionAuthorities)
        .where(
          and(
            eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
            eq(workflowExecutionAuthorities.id, fixture.authorityId!),
          ),
        );
      expect(authority?.reserved_runs).toBe(2);
    } finally {
      await client.close();
    }
  });

  test("held preparation does not masquerade as the declared live output schema", async () => {
    const fixture = await boundedFixture("none", true);
    const before = writes;
    const client = await connect();
    try {
      await client.listTools();
      const result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(body(result)).toMatchObject({
        status: "preparation",
        live_execution_authorized: false,
      });
      expect(writes).toBe(before);
    } finally {
      await client.close();
    }
  });

  test("a development authority cannot authorize a production MCP call", async () => {
    const fixture = await boundedFixture("active");
    const before = writes;
    const client = await connect();
    try {
      const result = await client.callTool({
        name: `wf_${fixture.slug}`,
        arguments: {},
        _meta: { environment: "prod" },
      });
      expect(body(result)).toMatchObject({
        status: "preparation",
        live_execution_authorized: false,
      });
      expect(writes).toBe(before);
    } finally {
      await client.close();
    }
  });

  test("a changed active version cannot inherit an earlier MCP execution authority", async () => {
    const fixture = await boundedFixture("active");
    const [version] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: fixture.id,
        version: 2,
        dag: {
          name: fixture.slug,
          steps: [
            {
              kind: "request",
              id: "send",
              method: "POST",
              url: `${mockBase}/bounded-write`,
              body: { recipient: "changed@example.test" },
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("missing changed version fixture");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, fixture.id)));
    const before = writes;
    const client = await connect();
    try {
      const result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
      expect(body(result)).toMatchObject({
        status: "preparation",
        live_execution_authorized: false,
      });
      expect(writes).toBe(before);
    } finally {
      await client.close();
    }
  });

  test.each(["expired", "revoked"] as const)(
    "%s authority cannot dispatch through MCP",
    async (state) => {
      const fixture = await boundedFixture(state);
      const before = writes;
      const client = await connect();
      try {
        const result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
        expect(body(result)).toMatchObject({
          live_execution_authorized: false,
          status: "preparation",
        });
        expect(writes).toBe(before);
      } finally {
        await client.close();
      }
    },
  );

  test("parallel MCP calls cannot exceed the last two authorized runs", async () => {
    const fixture = await boundedFixture("active");
    const before = writes;
    const client = await connect();
    try {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          client.callTool({ name: `wf_${fixture.slug}`, arguments: {} }),
        ),
      );
      expect(results.filter((result) => body(result).status === "preparation")).toHaveLength(1);
      expect(writes).toBe(before + 2);
      const rows = await ctx.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, fixture.id)));
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.execution_authority_id === fixture.authorityId)).toHaveLength(
        2,
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    } finally {
      await client.close();
    }
  });

  test("tools/call runs the workflow and creates an execution row", async () => {
    const priorCount =
      (
        await ctx.db
          .select({ c: count() })
          .from(executions)
          .where(eq(executions.workflow_id, toolWfId))
      )[0]?.c ?? 0;

    const client = await connect();
    try {
      const result = await client.callTool({
        name: `wf_${toolWfSlug}`,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const afterCount =
      (
        await ctx.db
          .select({ c: count() })
          .from(executions)
          .where(eq(executions.workflow_id, toolWfId))
      )[0]?.c ?? 0;
    expect(afterCount).toBeGreaterThan(priorCount);
  });

  test("tools/call for unknown wf_<slug> returns an error envelope", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "wf_definitely-not-a-real-slug-xyz123",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text;
      const body = JSON.parse(text!) as {
        status: string;
        error_code: string;
        next_best_actions: string[];
      };
      expect(body.status).toBe("cannot_help");
      expect(body.error_code).toBe("workflow_not_found");
      expect(body.next_best_actions).toContain("find_workflow");
    } finally {
      await client.close();
    }
  });

  test("tools/call for a tool absent from this surface returns a terminal cannot_help", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "totally_made_up_tool_xyz",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text;
      const body = JSON.parse(text!) as {
        status: string;
        error_code: string;
        next_best_actions: string[];
      };
      expect(body.status).toBe("cannot_help");
      expect(body.error_code).toBe("unknown_tool");
      expect(body.next_best_actions).toContain("conversation_start");
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
