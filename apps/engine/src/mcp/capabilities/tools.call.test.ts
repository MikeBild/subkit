import { describe, expect, test } from "bun:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, count, eq, sql } from "drizzle-orm";
import { MCP_AUTHORING_SCOPE } from "../../auth/scopes.ts";
import {
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { journeyFetch } from "../../tests/journeys/setup.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import {
  connect,
  ctx,
  issueApiKey,
  mockBase,
  setupMcpTools,
  toolWfId,
  toolWfSlug,
  writes,
} from "./tests/tools-fixtures.ts";

setupMcpTools();

let boundaryFixture = 0;

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
      const rows = await ctx.db
        .select({
          caller: executions.caller_context,
          held: executions.hold_writes,
          authorization: executions.authorization_context,
        })
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, fixture.id)));
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.held)).toHaveLength(1);
      for (const row of rows) expect(row.authorization?.source.kind).toBe("api_key");
      for (const row of rows)
        expect(row.caller).toMatchObject({
          tenantId: ctx.tenantId,
          principalId: ctx.userId,
          principalKind: "user",
          productId: null,
        });
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
      const callAfterCatalogConflict = async () => {
        let result: Awaited<ReturnType<typeof client.callTool>> | undefined;
        await waitFor(
          async () => {
            try {
              result = await client.callTool({ name: `wf_${fixture.slug}`, arguments: {} });
              return true;
            } catch (error) {
              if (
                error instanceof Error &&
                (error as { code?: unknown }).code === -32603 &&
                error.message ===
                  "MCP error -32603: Catalog vocabulary changed concurrently; retry the operation"
              )
                return false;
              throw error;
            }
          },
          { tries: 100, sleepMs: 5, label: "MCP admission after catalog conflict" },
        );
        if (!result) throw new Error("MCP admission did not return a result");
        return result;
      };
      const results = await Promise.all(Array.from({ length: 3 }, callAfterCatalogConflict));
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
    const client = await connect(await issueApiKey([MCP_AUTHORING_SCOPE]));
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
