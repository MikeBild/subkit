import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { GeneratedWorkflowSchema } from "../../../conversations/authoring-pipeline.ts";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { startLocalTargetServer } from "../../../test-helpers/local-http.ts";
import { AiSdkModel } from "../ai-sdk-model.ts";
import { initializeModel } from "../model-init.ts";
import { repairToolCall } from "../repair-tool-call.ts";

const bodies: Array<Record<string, unknown>> = [];
let server: { url: string; stop: () => Promise<void> };
let previousBaseUrl: string | undefined;

beforeAll(async () => {
  server = await startLocalTargetServer(async (req) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "captured", type: "test" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url;
});

afterAll(async () => {
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousBaseUrl;
  await server.stop();
});

type CapturedBody = {
  text?: { format?: { strict?: boolean; schema?: { properties?: Record<string, unknown> } } };
  response_format?: {
    json_schema?: { strict?: boolean; schema?: { properties?: Record<string, unknown> } };
  };
};

describe("structured output through the OpenAI provider", () => {
  test("the workflow schema goes out non-strict, so optional fields such as response_filters items are accepted", async () => {
    const model = new AiSdkModel({
      providerOverride: "openai",
      apiKeyOverride: "sk-test-not-a-real-key",
      defaultModel: "gpt-5.6-sol",
      modelOverride: "gpt-5.6-sol",
    });
    await model
      .generateObject({
        messages: [{ role: "user", content: "author a two-step workflow" }],
        schema: zodToJsonSchema7(GeneratedWorkflowSchema) as Record<string, unknown>,
      })
      .catch(() => undefined);

    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] as CapturedBody;
    const format = body.text?.format ?? body.response_format?.json_schema;
    expect(format?.strict).toBe(false);
    expect(Object.keys(format?.schema?.properties ?? {})).toContain("response_filters");
  });

  test("the abort tool lists every property as required so strict tool validation accepts it", async () => {
    bodies.length = 0;
    const model = new AiSdkModel({
      providerOverride: "openai",
      apiKeyOverride: "sk-test-not-a-real-key",
      defaultModel: "gpt-5.6-sol",
      modelOverride: "gpt-5.6-sol",
    });
    await model
      .generateObject({
        messages: [{ role: "user", content: "author a two-step workflow" }],
        schema: zodToJsonSchema7(GeneratedWorkflowSchema) as Record<string, unknown>,
      })
      .catch(() => undefined);
    const tools = (bodies[0] as { tools?: CapturedTool[] }).tools ?? [];
    const abort = tools.find((t) => (t.function?.name ?? t.name) === "abort");
    const parameters = abort?.function?.parameters ?? abort?.parameters;
    expect(parameters?.required).toEqual(["reason", "needs"]);
    expect(parameters?.properties?.needs?.items?.required).toEqual([
      "kind",
      "connector_slug",
      "method",
      "path",
      "question",
    ]);
  });

  test("a tool-call repair asks OpenAI for a non-strict schema, so optional tool arguments are accepted", async () => {
    bodies.length = 0;
    const { model } = await initializeModel({
      providerOverride: "openai",
      apiKeyOverride: "sk-test-not-a-real-key",
      defaultModel: "gpt-5.6-sol",
      modelOverride: "gpt-5.6-sol",
    });
    const err = new Error("Invalid input for tool run_workflow");
    err.name = "AI_InvalidToolInputError";
    await repairToolCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "run_workflow",
        input: JSON.stringify({ input: {} }),
      },
      tools: {
        run_workflow: tool({
          description: "run",
          inputSchema: z.object({ workflow: z.string(), input: z.unknown().optional() }),
        }),
      },
      messages: [],
      system: "",
      error: err as never,
      model,
    });
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] as CapturedBody;
    const format = body.text?.format ?? body.response_format?.json_schema;
    expect(format?.strict).toBe(false);
  });
});

type CapturedSchema = {
  required?: string[];
  properties?: Record<string, { items?: { required?: string[] } }>;
};

type CapturedTool = {
  name?: string;
  parameters?: CapturedSchema;
  function?: { name?: string; parameters?: CapturedSchema };
};
