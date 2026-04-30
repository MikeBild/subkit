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
import { logger } from "../../logging/logger.ts";

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
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK Tool inputSchema is JSONSchema-shaped at runtime.
  const inputSchema = (tool as any).inputSchema as Record<string, unknown> | undefined;
  if (!inputSchema) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.no_input_schema",
      msg: "tool has no input schema — cannot repair",
      tool: toolCall.toolName,
    });
    return null;
  }
  try {
    const repaired = await generateObject({
      model,
      // biome-ignore lint/suspicious/noExplicitAny: inputSchema may be JSON Schema object or zod Schema; jsonSchema accepts both.
      schema: jsonSchema(inputSchema as any),
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
    logger.warn({
      module: "llm",
      action: "repair_tool_call.failed",
      msg: "repair attempt threw — surfacing original error to the loop",
      tool: toolCall.toolName,
      error: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
