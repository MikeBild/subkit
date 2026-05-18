// repair-tool-call — experimental_repairToolCall handler.
//
// When the model emits a tool call whose JSON arguments fail schema
// validation (or names a non-existent tool), the AI SDK calls this
// hook with the raw call + parser error. We re-prompt the model to
// produce a corrected call by feeding the failing input + the parser
// error back through `generateObject` against the same input schema.
//
// Returning `null` skips repair and surfaces the failure to the loop
// (which then either ends the step with an error or tries again on
// the next turn). Repair is bounded to one attempt per failing call;
// repeated failures fall through to the loop's existing error path.

import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type {
  InvalidToolInputError,
  LanguageModel,
  ModelMessage,
  NoSuchToolError,
  Tool,
  ToolSet,
} from "ai";
import { generateObject, jsonSchema } from "ai";
import { z } from "zod";
import { logger } from "../../logging/logger.ts";
import { normalizeSchema } from "./schema-normalizer.ts";

export interface RepairToolCallParams<TOOLS extends ToolSet> {
  toolCall: LanguageModelV3ToolCall;
  tools: TOOLS;
  messages: ModelMessage[];
  system: string | unknown;
  error: NoSuchToolError | InvalidToolInputError;
  /** Already-resolved language model — same instance the loop is using. */
  model: LanguageModel;
  /** Callback invoked when repair fired so the loop can flip a signal flag. */
  onRepair?: () => void;
}

export async function repairToolCall<TOOLS extends ToolSet>(
  params: RepairToolCallParams<TOOLS>,
): Promise<LanguageModelV3ToolCall | null> {
  const { toolCall, tools, error, model, onRepair } = params;
  logger.info({
    module: "llm",
    action: "repair_tool_call.started",
    msg: "model emitted a malformed tool call — attempting in-band repair",
    tool: toolCall.toolName,
    error_kind: error.name,
    error_message: error.message,
    raw_input_kind: typeof toolCall.input,
  });
  const tool = (tools as Record<string, Tool>)[toolCall.toolName];
  if (!tool) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.unknown_tool",
      msg: "model called a tool that does not exist in the palette — skipping repair",
      tool: toolCall.toolName,
      available_tools: Object.keys(tools).slice(0, 20),
    });
    return null;
  }
  // biome-ignore lint/suspicious/noExplicitAny: Tool.inputSchema may be a Zod schema, a Valibot schema, or a plain JSON-Schema object.
  const rawInputSchema = (tool as any).inputSchema as unknown;
  if (!rawInputSchema) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.no_input_schema",
      msg: "tool has no input schema — cannot repair",
      tool: toolCall.toolName,
    });
    return null;
  }
  // Convert to JSON Schema if the tool was registered with a Zod
  // schema (the in-repo `ConversationTool` path), then push through
  // `normalizeSchema` so the structured-output call matches the
  // healthy `generateObject` path in `ai-sdk-model.ts` — which seals
  // every object with `additionalProperties: false`. Skipping that
  // normalization is the original bug: Anthropic SDK 6 strict-mode
  // rejects unsealed objects with `output_config.format.schema: For
  // 'object' type, 'additionalProperties' must be explicitly set to
  // false` (trace cli-eff8d7d79d724c56, 2026-05-12).
  const jsonSchemaShape = toJsonSchemaShape(rawInputSchema);
  if (!jsonSchemaShape) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.no_input_schema",
      msg: "tool input schema could not be converted to JSON Schema — cannot repair",
      tool: toolCall.toolName,
    });
    return null;
  }
  const { schema: normalizedSchema } = normalizeSchema(jsonSchemaShape);
  try {
    const repaired = await generateObject({
      model,
      schema: jsonSchema(normalizedSchema as Parameters<typeof jsonSchema>[0]),
      messages: [
        {
          role: "system",
          content:
            "Re-emit ONLY a valid JSON object that satisfies the tool's input schema. " +
            "Do not include any prose. Reply with the corrected arguments only.",
        },
        {
          role: "user",
          content:
            `The previous call to "${toolCall.toolName}" failed validation. ` +
            `Parser error: ${error.message}\n\n` +
            `Original arguments: ${typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input)}\n\n` +
            "Return a corrected JSON object only.",
        },
      ],
      maxRetries: 0,
    });
    onRepair?.();
    logger.info({
      module: "llm",
      action: "repair_tool_call.repaired",
      msg: "in-band tool-call repair succeeded — feeding corrected args back to the loop",
      tool: toolCall.toolName,
      original_input:
        typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input),
      repaired_input_keys:
        typeof repaired.object === "object" && repaired.object !== null
          ? Object.keys(repaired.object).slice(0, 20)
          : [],
    });
    return {
      ...toolCall,
      input: JSON.stringify(repaired.object),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.name : "unknown";
    logger.warn({
      module: "llm",
      action: "repair_tool_call.failed",
      msg: "repair attempt threw — surfacing original error to the loop",
      tool: toolCall.toolName,
      error: errMsg,
      error_name: errName,
      ...(isSchemaRejectionError({ errName, errMsg })
        ? { normalized_schema: JSON.stringify(normalizedSchema).slice(0, 4000) }
        : {}),
    });
    return null;
  }
}

/**
 * Heuristic detector for provider-side structured-output schema
 * rejections. When the provider rejects the schema itself (Anthropic
 * returns `AI_APICallError` with `output_config.format.schema` in the
 * message), the warn-level emitter attaches the normalised schema
 * fragment as a load-bearing diagnostic. Exported so the heuristic
 * has unit coverage independent of the AI SDK mock surface.
 */
export function isSchemaRejectionError(input: { errName: string; errMsg: string }): boolean {
  return (
    input.errName === "AI_APICallError" ||
    input.errMsg.includes("output_config.format.schema") ||
    input.errMsg.includes("Empty schema") ||
    input.errMsg.includes("Schema type")
  );
}

/**
 * Coerce a `Tool.inputSchema` to a plain JSON Schema object. Accepts
 * a Zod schema (converted via the v4 native exporter) or a value that
 * already looks like JSON Schema. Returns null when neither shape is
 * detected, so the caller can skip repair instead of feeding garbage
 * through the structured-output path.
 */
function toJsonSchemaShape(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && "_def" in (raw as Record<string, unknown>)) {
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 type surface — toJSONSchema lives on the runtime module, not the typed export.
    const out = (z as any).toJSONSchema(raw, { target: "jsonSchema7" });
    return out as Record<string, unknown>;
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return null;
}
