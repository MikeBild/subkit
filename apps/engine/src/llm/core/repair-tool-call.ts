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
import type { ZodType } from "zod";
import type { KnownAuditActorType } from "../../audit/types.ts";
import type { Executor } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import { account } from "../accounting/accountant.ts";
import { extractCacheCreation, extractCacheRead } from "./ai-sdk-model.ts";
import { normalizeSchema } from "./schema-normalizer.ts";

export interface RepairToolCallParams<TOOLS extends ToolSet> {
  toolCall: LanguageModelV3ToolCall;
  tools: TOOLS;
  messages: ModelMessage[];
  system: string | unknown;
  error: NoSuchToolError | InvalidToolInputError;
  model: LanguageModel;
  onRepair?: () => void;
  accounting?: {
    tenant_id: string;
    conversation_id?: string | undefined;
    user_id?: string | null | undefined;
    actor_type?: KnownAuditActorType | undefined;
    db?: Executor | undefined;
  };
}

export async function recordRepairUsage(
  accounting: RepairToolCallParams<ToolSet>["accounting"],
  model: LanguageModel,
  result: {
    usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
    providerMetadata?: unknown;
  },
  latencyMs: number,
): Promise<void> {
  if (!accounting) return;
  try {
    await account(
      {
        tenant_id: accounting.tenant_id,
        metadata: {
          tenant_id: accounting.tenant_id,
          flow: "tool_repair",
          ...(accounting.conversation_id ? { conversation_id: accounting.conversation_id } : {}),
        },
        model: typeof model === "string" ? model : (model.modelId ?? "unknown"),
        usage: {
          input_tokens: Number(result.usage?.inputTokens ?? 0),
          output_tokens: Number(result.usage?.outputTokens ?? 0),
          cache_read_tokens: extractCacheRead(result.providerMetadata),
          cache_creation_tokens: extractCacheCreation(result.providerMetadata),
        },
        latency_ms: latencyMs,
        result: "success",
        user_id: accounting.user_id ?? null,
        actor_type: accounting.actor_type ?? "system",
      },
      accounting.db,
    );
  } catch (err) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.accounting_failed",
      msg: "tool-call repair succeeded but its usage row did not write",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function repairToolCall<TOOLS extends ToolSet>(
  params: RepairToolCallParams<TOOLS>,
): Promise<LanguageModelV3ToolCall | null> {
  const { toolCall, tools, error, model, onRepair, accounting } = params;
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
    const isWfAlias = toolCall.toolName.startsWith("wf_");
    const isBareRunWorkflow = toolCall.toolName === "run_workflow";
    if (isWfAlias || isBareRunWorkflow) {
      const toolset = tools as Record<string, Tool>;
      if (isWfAlias && toolset.run_workflow) {
        const slug = toolCall.toolName.slice(3).replace(/_/g, "-");
        const rawInput =
          typeof toolCall.input === "string" && toolCall.input.trim().length > 0
            ? toolCall.input
            : JSON.stringify(toolCall.input ?? {});
        logger.info({
          module: "llm",
          action: "repair_tool_call.wf_alias_rewrite",
          msg: "model called a wf_* tool missing from the palette — rewriting to run_workflow",
          tool: toolCall.toolName,
          workflow: slug,
        });
        onRepair?.();
        return {
          ...toolCall,
          toolName: "run_workflow",
          input: JSON.stringify({ workflow: slug, input: rawInput }),
        };
      }
      if (toolset.dry_run_workflow) {
        const parsedInput = parseOriginalInput(toolCall.input);
        logger.info({
          module: "llm",
          action: "repair_tool_call.dry_run_alias_rewrite",
          msg: "model called an execution tool missing from the palette — rewriting to dry_run_workflow (draft run)",
          tool: toolCall.toolName,
          rewritten_to: "dry_run_workflow",
        });
        onRepair?.();
        return {
          ...toolCall,
          toolName: "dry_run_workflow",
          input: JSON.stringify({ input: parsedInput }),
        };
      }
      if (toolset.find_workflow) {
        const query = isWfAlias
          ? toolCall.toolName.slice(3).replace(/_/g, " ")
          : extractWorkflowQuery(toolCall.input);
        if (query) {
          logger.info({
            module: "llm",
            action: "repair_tool_call.find_workflow_rewrite",
            msg: "execution tool absent — rewriting to find_workflow so the model can discover then confirm-run",
            tool: toolCall.toolName,
            query,
          });
          onRepair?.();
          return {
            ...toolCall,
            toolName: "find_workflow",
            input: JSON.stringify({ query }),
          };
        }
      }
    }
    logger.warn({
      module: "llm",
      action: "repair_tool_call.unknown_tool",
      msg: "model called a tool that does not exist in the palette — skipping repair",
      tool: toolCall.toolName,
      available_tools: Object.keys(tools).slice(0, 20),
    });
    return null;
  }
  const rawInputSchema: unknown = tool.inputSchema;
  if (!rawInputSchema) {
    logger.warn({
      module: "llm",
      action: "repair_tool_call.no_input_schema",
      msg: "tool has no input schema — cannot repair",
      tool: toolCall.toolName,
    });
    return null;
  }
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
  const startedAt = Date.now();
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
      allowSystemInMessages: true,
    });
    await recordRepairUsage(accounting, model, repaired, Date.now() - startedAt);
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

function parseOriginalInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractWorkflowQuery(input: unknown): string | null {
  const parsed = parseOriginalInput(input);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const wf = (parsed as Record<string, unknown>).workflow;
    if (typeof wf === "string" && wf.trim().length > 0) {
      return wf.trim().replace(/-/g, " ");
    }
  }
  return null;
}

const SCHEMA_REJECTION_MARKERS = [
  "output_config.format.schema",
  "Empty schema",
  "Schema type",
] as const;

export function isSchemaRejectionError(input: { errName: string; errMsg: string }): boolean {
  return SCHEMA_REJECTION_MARKERS.some((marker) => input.errMsg.includes(marker));
}

function toJsonSchemaShape(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && "_def" in (raw as Record<string, unknown>)) {
    return zodToJsonSchema7(raw as ZodType);
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return null;
}
