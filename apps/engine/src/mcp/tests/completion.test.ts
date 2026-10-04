import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { skills } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

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

beforeAll(async () => {
  suite = await startMcpTestSuite("completion");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("mcp completion/complete", () => {
  test("ref/prompt returns matching skill argument names", async () => {
    const { id } = await suite.seedSkill({
      title: "Bake bread",
      body: "Use the oven.",
    });
    await suite.http.db
      .update(skills)
      .set({
        arguments: [
          { name: "loaf_count", description: "How many loaves" },
          { name: "loaf_style", description: "sourdough or focaccia" },
          { name: "oven_temp_c", description: "Bake temperature" },
        ],
      })
      .where(eq(skills.id, id));

    const client = await suite.connect();
    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: `skill_${id}` },
          argument: { name: "name", value: "loaf" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    expect(res.completion.values).toEqual(["loaf_count", "loaf_style"]);
    expect(res.completion.total).toBe(3);
  });

  test("ref/tool returns matching workflow input_schema property names", async () => {
    await suite.seedWorkflow({
      name: "complete probe",
      slug: "complete-probe",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "echo",
          expression: "$input",
        },
      ],
    });

    const client = await suite.connect();
    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/tool", name: "wf_complete-probe" },
          argument: { name: "name", value: "l" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    expect(res.completion.values).toEqual(["limit"]);
    expect(res.completion.total).toBe(3);
  });

  test("ref/resource returns an empty list", async () => {
    const { id } = await suite.seedConnector({ slug: "compl-connector" });
    const client = await suite.connect();
    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/resource", uri: `connector://${id}` },
          argument: { name: "name", value: "" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );
    expect(res.completion.values).toEqual([]);
  });

  test("prompt completions do not leak argument metadata without skill:read", async () => {
    const { id } = await suite.seedSkill({
      title: "Hidden prompt",
      body: "Do hidden work.",
      arguments: [
        { name: "secret_customer_id", description: "sensitive argument" },
        { name: "secret_region", description: "sensitive argument" },
      ],
    });
    const { plaintext } = await suite.issueApiKey(["workflow:read"]);
    const client = await suite.connectWithApiKey(plaintext);

    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/prompt", name: `skill_${id}` },
          argument: { name: "name", value: "secret" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );

    expect(res.completion.values).toEqual([]);
    expect(res.completion.total).toBe(0);
  });

  test("tool completions do not leak workflow input schema without workflow:read", async () => {
    await suite.seedWorkflow({
      name: "hidden workflow",
      slug: "hidden-workflow",
      input_schema: {
        type: "object",
        properties: {
          secret_limit: { type: "number" },
          secret_filter: { type: "string" },
        },
      },
      steps: [
        {
          kind: "transform",
          id: "echo",
          expression: "$input",
        },
      ],
    });
    const { plaintext } = await suite.issueApiKey(["skill:read"]);
    const client = await suite.connectWithApiKey(plaintext);

    const res = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: { type: "ref/tool", name: "wf_hidden-workflow" },
          argument: { name: "name", value: "secret" },
        },
      } as unknown as Parameters<typeof client.request>[0],
      CompletionResultSchema,
    );

    expect(res.completion.values).toEqual([]);
    expect(res.completion.total).toBe(0);
  });
});
