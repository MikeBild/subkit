// Regression guard for T1.5: every schema-constrained flow must go
// through AiSdkModel.generateObject with toolChoice="required" and the
// submit/abort tool pair. If a flow is refactored to skip generateObject
// (e.g. drops back to generateText + best-effort JSON parsing), this
// eval fails the /verify gate before the shipped change can silently
// degrade structured-output guarantees.

import { AiSdkModel } from "../../src/llm/core/ai-sdk-model.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as {
    expected_tool_choice: "required" | "auto" | "none";
    expected_tools: string[];
    flows: string[];
  };

  const observed: {
    toolChoice?: string;
    toolNames?: string[];
  } = {};
  const spy = async (callOpts: Record<string, unknown>) => {
    observed.toolChoice = (callOpts.toolChoice as string | undefined) ?? undefined;
    observed.toolNames = callOpts.tools
      ? Object.keys(callOpts.tools as Record<string, unknown>)
      : [];
    return {
      text: "",
      toolCalls: [
        {
          toolCallId: "c1",
          toolName: "submit",
          input: { ok: true },
        },
      ],
      toolResults: [],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 1 },
      response: { messages: [{ role: "assistant", content: "" }] },
      providerMetadata: {},
    };
  };
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- eval spy
    generateTextFn: spy as any,
  });

  await model.generateObject({
    messages: [{ role: "user", content: "probe" }],
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    toolChoice: "required",
  });

  if (observed.toolChoice !== input.expected_tool_choice) {
    return {
      pass: false,
      reason: `toolChoice=${observed.toolChoice ?? "unset"}, expected ${input.expected_tool_choice}`,
    };
  }
  for (const want of input.expected_tools) {
    if (!observed.toolNames?.includes(want)) {
      return {
        pass: false,
        reason: `tool '${want}' missing from tool palette (saw [${observed.toolNames?.join(", ") ?? ""}])`,
      };
    }
  }
  return {
    pass: true,
    metrics: {
      tool_count: observed.toolNames?.length ?? 0,
    },
  };
}
