import { describe, expect, test } from "bun:test";
import { workflowDefinition } from "../commands/workflows.ts";
import type { ExecutionRunDraftDefinition } from "../engine-client/executions.ts";
import { EngineClient } from "../engine-client.ts";

function recordingClient() {
  const bodies: unknown[] = [];
  const client = new EngineClient({
    engine_url: "https://engine.test",
    api_key: "key",
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ execution_id: "e1", status: "succeeded" });
    },
  });
  return { client, bodies };
}

const definition: ExecutionRunDraftDefinition = {
  name: "Product briefing",
  product_id: "briefing-app",
  required_caller_kind: "user",
  execution_privacy: "sensitive",
  tool_effect: "read",
  validation_expression: "ok = true",
  output_transform: '{"summary": summary}',
  response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "^token$" }],
  steps: [{ id: "read", kind: "request", method: "GET", url: "https://api.test/briefing" }],
  timeout_ms: 30_000,
  max_llm_tokens_per_run: 4_000,
  runtime: { stdlib_version: "1" },
  execution_guards: { input_bytes: { question: 2_000 } },
  caller_erasure: "on_success",
};

describe("draft runs", () => {
  test("a typed draft reaches the engine with every field that shapes the run", async () => {
    const { client, bodies } = recordingClient();
    await client.runExecution({ source: "draft", definition, request_source: "cli" });
    expect(bodies).toEqual([{ source: "draft", definition, request_source: "cli" }]);
  });

  test("a workflow file previews as a draft with its run fields", async () => {
    const { client, bodies } = recordingClient();
    const file = workflowDefinition({ ...definition, category: "briefings" });
    await client.runExecution({ source: "draft", definition: file, request_source: "cli" });
    expect(bodies).toEqual([
      {
        source: "draft",
        definition: { ...definition, category: "briefings" },
        request_source: "cli",
      },
    ]);
  });
});
