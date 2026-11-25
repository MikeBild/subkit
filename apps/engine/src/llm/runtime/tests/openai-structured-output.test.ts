import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stripPropertyNames } from "@shared/json-schema.ts";
import { asSchema, tool } from "ai";
import { z } from "zod";
import { GeneratedWorkflowSchema } from "../../../conversations/authoring-pipeline.ts";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { startLocalTargetServer } from "../../../test-helpers/local-http.ts";
import { AiSdkModel } from "../ai-sdk-model.ts";
import { initializeModel } from "../model-init.ts";
import { repairToolCall } from "../repair-tool-call.ts";

const bodies: Array<Record<string, unknown>> = [];
let server: { url: string; stop: () => Promise<void> };
let previousBaseUrl: string | undefined;
let reply: { status: number; body: unknown } = {
  status: 400,
  body: { error: { message: "captured", type: "test" } },
};

beforeAll(async () => {
  server = await startLocalTargetServer(async (req) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  previousBaseUrl = testEnv.OPENAI_BASE_URL;
  testEnv.OPENAI_BASE_URL = server.url;
});

afterAll(async () => {
  if (previousBaseUrl === undefined) delete testEnv.OPENAI_BASE_URL;
  else testEnv.OPENAI_BASE_URL = previousBaseUrl;
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
      "skill_slug",
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

describe("propertyNames never reaches the OpenAI provider", () => {
  const labels = z.record(z.string(), z.string());
  const toolInput = z.object({
    labels,
    rows: z.array(z.object({ scores: z.record(z.enum(["low", "high"]), z.number()) })),
    target: z.union([z.object({ headers: labels }), z.string()]),
  });

  test("the zod tool schema carries propertyNames before sanitizing", async () => {
    expect(JSON.stringify(await asSchema(toolInput).jsonSchema)).toContain("propertyNames");
  });

  test("tool and response schemas raise no propertyNames compatibility warning", async () => {
    bodies.length = 0;
    const warnings: Array<{ feature?: string }> = [];
    const globals = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
    const previousLogger = globals.AI_SDK_LOG_WARNINGS;
    globals.AI_SDK_LOG_WARNINGS = (options: { warnings: Array<{ feature?: string }> }) => {
      warnings.push(...options.warnings);
    };
    const previousReply = reply;
    reply = {
      status: 200,
      body: {
        id: "chatcmpl_1",
        created: 0,
        model: "gpt-5.6-sol",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ propertyNames: "x", groups: [] }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    };
    try {
      const model = new AiSdkModel({
        providerOverride: "openai",
        apiKeyOverride: "sk-test-not-a-real-key",
        defaultModel: "gpt-5.6-sol",
        modelOverride: "gpt-5.6-sol",
      });
      const result = await model.generateObject({
        messages: [{ role: "user", content: "tag the rows" }],
        schema: {
          type: "object",
          properties: {
            propertyNames: { type: "string" },
            groups: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
                propertyNames: { pattern: "^[a-z]+$" },
              },
            },
          },
          required: ["propertyNames", "groups"],
          propertyNames: { type: "string" },
        },
        tools: [
          { toolDefinition: { tag_rows: tool({ description: "tag", inputSchema: toolInput }) } },
        ],
      });
      expect(result.success).toBe(true);
    } finally {
      globals.AI_SDK_LOG_WARNINGS = previousLogger;
      reply = previousReply;
    }

    expect(JSON.stringify(bodies[0])).toContain("tag_rows");
    expect(warnings.map((warning) => warning.feature)).not.toContain("JSON Schema propertyNames");
  });

  test("stripPropertyNames keeps fields named propertyNames and literal data", () => {
    expect(
      stripPropertyNames({
        type: "object",
        propertyNames: { type: "string" },
        properties: { propertyNames: { type: "string", propertyNames: { type: "string" } } },
        default: { propertyNames: 1 },
        $defs: { node: { type: "object", propertyNames: { maxLength: 3 } } },
      }),
    ).toEqual({
      type: "object",
      properties: { propertyNames: { type: "string" } },
      default: { propertyNames: 1 },
      $defs: { node: { type: "object" } },
    });
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
