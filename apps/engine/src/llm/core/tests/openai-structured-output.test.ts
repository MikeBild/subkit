import { afterEach, describe, expect, test } from "bun:test";
import { GeneratedWorkflowSchema } from "../../../conversations/authoring-pipeline.ts";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { AiSdkModel } from "../ai-sdk-model.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureOpenAiRequests(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ error: { message: "captured", type: "test" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return bodies;
}

describe("structured output through the OpenAI provider", () => {
  test("the workflow schema goes out non-strict, so optional fields such as response_filters items are accepted", async () => {
    const bodies = captureOpenAiRequests();
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
    const body = bodies[0] as {
      text?: {
        format?: {
          type?: string;
          strict?: boolean;
          schema?: { properties?: Record<string, unknown> };
        };
      };
      response_format?: { json_schema?: { strict?: boolean } };
    };
    const strict = body.text?.format?.strict ?? body.response_format?.json_schema?.strict;
    expect(strict).toBe(false);
    expect(Object.keys(body.text?.format?.schema?.properties ?? {})).toContain("response_filters");
  });
});
