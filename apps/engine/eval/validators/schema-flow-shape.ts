import { AiSdkModel } from "../../src/llm/runtime/ai-sdk-model.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface ObservedCall {
  outputName?: string;
  responseFormat?: { type?: string; schema?: Record<string, unknown> };
  toolChoice?: unknown;
  toolNames: string[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as {
    expected_output: string;
    expected_value_keys: string[];
    required_tools: string[];
    forbidden_tools: string[];
    flows: string[];
  };

  let observed: ObservedCall | undefined;
  const spy = async (callOpts: Record<string, unknown>) => {
    const output = callOpts.output as
      | { name?: string; responseFormat?: PromiseLike<ObservedCall["responseFormat"]> }
      | undefined;
    observed = {
      ...(output?.name !== undefined ? { outputName: output.name } : {}),
      ...(output?.responseFormat ? { responseFormat: await output.responseFormat } : {}),
      toolChoice: callOpts.toolChoice,
      toolNames: callOpts.tools ? Object.keys(callOpts.tools as Record<string, unknown>) : [],
    };
    const value = { ok: true };
    return {
      text: JSON.stringify(value),
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 1 },
      response: { messages: [{ role: "assistant", content: JSON.stringify(value) }] },
      providerMetadata: {},
      output: value,
    };
  };
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    // biome-ignore lint/suspicious/noExplicitAny: eval spy
    generateTextFn: spy as any,
  });

  await model.generateObject({
    messages: [{ role: "user", content: "probe" }],
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  });

  if (!observed) return { pass: false, reason: "generateText was never called" };
  const call: ObservedCall = observed;
  if (call.outputName !== input.expected_output) {
    return {
      pass: false,
      reason: `output=${call.outputName ?? "unset"}, expected ${input.expected_output}`,
    };
  }
  const schema = call.responseFormat?.schema;
  if (call.responseFormat?.type !== "json" || !schema || schema.type !== "object") {
    return { pass: false, reason: "structured output schema is not an object-rooted json format" };
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of input.expected_value_keys) {
    if (!required.includes(key)) {
      return { pass: false, reason: `value key '${key}' missing from required [${required}]` };
    }
  }
  if ("ok" in schema && "value" in (schema.properties as Record<string, unknown>)) {
    return { pass: false, reason: "structured output is wrapped in an outcome object again" };
  }
  if (call.toolChoice !== undefined) {
    return { pass: false, reason: `toolChoice=${String(call.toolChoice)}, expected unset` };
  }
  for (const needed of input.required_tools) {
    if (!call.toolNames.includes(needed)) {
      return {
        pass: false,
        reason: `tool '${needed}' missing from the palette [${call.toolNames}]`,
      };
    }
  }
  for (const forbidden of input.forbidden_tools) {
    if (call.toolNames.includes(forbidden)) {
      return { pass: false, reason: `tool '${forbidden}' must not be in the palette any more` };
    }
  }
  return {
    pass: true,
    metrics: {
      tool_count: call.toolNames.length,
    },
  };
}
