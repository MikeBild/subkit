import { AiSdkModel } from "../../src/llm/core/ai-sdk-model.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as {
    schema: Record<string, unknown>;
    value: Record<string, unknown>;
  };
  let steps = 0;
  const stub = async () => {
    steps += 1;
    const outcome = { ok: true, value: input.value, reason: null };
    return {
      text: JSON.stringify(outcome),
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
      response: { messages: [{ role: "assistant", content: JSON.stringify(outcome) }] },
      providerMetadata: {},
      steps: [{}],
      output: outcome,
    };
  };
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    // biome-ignore lint/suspicious/noExplicitAny: eval stub
    generateTextFn: stub as any,
  });
  const result = await model.generateObject({
    messages: [{ role: "user", content: "x" }],
    schema: input.schema,
  });
  if (!result.success)
    return { pass: false, reason: `generateObject returned success=false: ${result.response}` };
  const response = result.response as Record<string, unknown>;
  for (const key of Object.keys(input.value)) {
    if (JSON.stringify(response[key]) !== JSON.stringify(input.value[key])) {
      return {
        pass: false,
        reason: `mismatch on key '${key}': got ${JSON.stringify(response[key])}`,
      };
    }
  }
  if (steps !== 1) {
    return { pass: false, reason: `expected one model call per structured answer, saw ${steps}` };
  }
  return {
    pass: true,
    metrics: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      model_calls: steps,
    },
  };
}
