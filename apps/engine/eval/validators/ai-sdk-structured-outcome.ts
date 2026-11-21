import { AiSdkModel } from "../../src/llm/runtime/ai-sdk-model.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

type GenerateText = NonNullable<
  Exclude<ConstructorParameters<typeof AiSdkModel>[0], string | undefined>["generateTextFn"]
>;

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as {
    schema: Record<string, unknown>;
    value: Record<string, unknown>;
    refusal: string;
  };
  let steps = 0;
  const answering = async () => {
    steps += 1;
    return {
      text: JSON.stringify(input.value),
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
      response: { messages: [{ role: "assistant", content: JSON.stringify(input.value) }] },
      providerMetadata: {},
      steps: [{}],
      output: input.value,
    };
  };
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    generateTextFn: answering as unknown as GenerateText,
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

  const refusing = async () => ({
    text: "",
    toolCalls: [{ toolCallId: "c1", toolName: "abort", input: { reason: input.refusal } }],
    toolResults: [],
    finishReason: "tool-calls",
    usage: { inputTokens: 10, outputTokens: 2 },
    response: { messages: [] },
    providerMetadata: {},
    steps: [{}],
  });
  const refusingModel = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    generateTextFn: refusing as unknown as GenerateText,
  });
  const refused = await refusingModel.generateObject({
    messages: [{ role: "user", content: "x" }],
    schema: input.schema,
  });
  if (refused.success) return { pass: false, reason: "an abort tool call was read as a success" };
  if (refused.response !== input.refusal) {
    return { pass: false, reason: `refusal reason lost: got ${JSON.stringify(refused.response)}` };
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
