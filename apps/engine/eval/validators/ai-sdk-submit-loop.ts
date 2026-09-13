import { AiSdkModel } from "../../src/llm/core/ai-sdk-model.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as {
    schema: Record<string, unknown>;
    submit: Record<string, unknown>;
  };
  const stub = async () => ({
    text: "",
    toolCalls: [{ toolCallId: "c1", toolName: "submit", input: input.submit }],
    toolResults: [],
    finishReason: "tool-calls",
    usage: { inputTokens: 10, outputTokens: 2 },
    response: { messages: [{ role: "assistant", content: "" }] },
    providerMetadata: {},
  });
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- eval stub
    generateTextFn: stub as any,
  });
  const result = await model.generateObject({
    messages: [{ role: "user", content: "x" }],
    schema: input.schema,
  });
  if (!result.success)
    return { pass: false, reason: `generateObject returned success=false: ${result.response}` };
  const response = result.response as Record<string, unknown>;
  for (const key of Object.keys(input.submit)) {
    if (JSON.stringify(response[key]) !== JSON.stringify(input.submit[key])) {
      return {
        pass: false,
        reason: `mismatch on key '${key}': got ${JSON.stringify(response[key])}`,
      };
    }
  }
  return {
    pass: true,
    metrics: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  };
}
