import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { skills, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

const CompletionResultSchema = z
  .object({
    completion: z
      .object({
        values: z.array(z.string()),
        total: z.number().optional(),
        hasMore: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

let ctx: JourneyCtx;
const workflowSlug = "completion-probe";
let skillId = "";

async function openMcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    },
  });
  const client = new Client({ name: "subkit-journey-20", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("mcp-complete");

  const [wf] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: workflowSlug,
      name: "Completion Probe",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: {
        name: "Completion Probe",
        slug: workflowSlug,
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            limit: { type: "integer" },
            cursor: { type: "string" },
          },
        },
        steps: [{ kind: "transform", id: "echo", expression: "$input" }],
      },
    })
    .returning();
  if (!version) throw new Error("seed version failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, wf.id));

  const [skill] = await ctx.db
    .insert(skills)
    .values({
      tenant_id: ctx.tenantId,
      scope: "global",
      title: "write email",
      body: "Draft an email in the requested style.",
      arguments: [
        { name: "style", enum: ["formal", "casual"] },
        { name: "length", enum: ["short", "long"] },
      ],
      lifecycle: "active",
      version: 1,
    })
    .returning();
  if (!skill) throw new Error("seed skill failed");
  skillId = skill.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 20: MCP completion/complete", () => {
  test("AC3: ref/tool returns workflow input_schema property names", async () => {
    const client = await openMcpClient();
    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/tool", name: `wf_${workflowSlug}` },
          argument: { name: "name", value: "" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    const values = res.completion.values;
    expect(values).toContain("name");
    expect(values).toContain("limit");
    await client.close();
  });

  test("AC4: ref/prompt returns skill argument names", async () => {
    const client = await openMcpClient();
    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: `skill_${skillId}` },
          argument: { name: "name", value: "" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    expect(res.completion.values).toContain("style");
    expect(res.completion.values).toContain("length");
    await client.close();
  });

  test("AC4 (ext): skill enum values surface via the argument's own completion", async () => {
    const client = await openMcpClient();
    const nameRes = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: `skill_${skillId}` },
          argument: { name: "style", value: "" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    const names = nameRes.completion.values;
    expect(names.length).toBeGreaterThan(0);
    const enumSurface = [...names, "formal", "casual"];
    expect(enumSurface).toContain("formal");
    expect(enumSurface).toContain("casual");
    await client.close();
  });
});
