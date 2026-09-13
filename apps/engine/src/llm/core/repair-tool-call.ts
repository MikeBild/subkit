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
import type { ZodType } from "zod";

import type { AuditActorType } from "../../audit/types.ts";
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
  /** Already-resolved language model — same instance the loop is using. */
  model: LanguageModel;
  /** Callback invoked when repair fired so the loop can flip a signal flag. */
  onRepair?: () => void;
  /**
   * Who to bill this to. Optional only because two tests construct the params
   * without a tenant; every production path supplies it.
   *
   * This call went unrecorded from the day it was written. It reaches the
   * provider through `generateObject` directly rather than through `invoke()`,
   * so none of the accounting wrapped around the latter applied — the tokens
   * were spent, billed, and absent from `llm_usage`. Small in volume (capped at
   * two per turn) and exactly the kind of omission that is invisible until
   * somebody reconciles a provider invoice against the ledger.
   */
  accounting?: {
    tenant_id: string;
    conversation_id?: string | undefined;
    /** From `actorFields(principal)` — the same attribution every other row uses. */
    user_id?: string | null | undefined;
    actor_type?: AuditActorType | undefined;
    /** Executor for the usage row. Omitted falls back to the ambient pool. */
    db?: Executor | undefined;
  };
}

/**
 * Record what the repair cost.
 *
 * Best-effort and silent on failure, matching the accountant's own contract:
 * the corrected tool call is already in hand, and refusing to return it because
 * a bookkeeping row would not insert would turn a recovered turn into a failed
 * one. A warning is logged; the caller is not told.
 *
 * The model id is read off the resolved model rather than passed in, so this
 * bills whatever the loop actually escalated to rather than what it started
 * with.
 */
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
    // The model named a tool the palette does not carry. Two shapes hit
    // this branch during authoring conversations, both meaning "test the
    // workflow I just built":
    //
    //   1. `wf_<slug>` — a per-workflow tool missing from this turn's
    //      palette (LRU-capped catalog, an invented name like
    //      `wf_org_top_repos`, or removed by the execution-tool gate on a
    //      draft-only conversation).
    //   2. bare `run_workflow` — removed by that same gate when no SAVED
    //      workflow is bound, yet the model still reaches for it to run
    //      its fresh draft.
    //
    // Rewrite precedence:
    //   (a) `wf_<slug>` + `run_workflow` present → run the named saved
    //       workflow (unchanged behavior; safe because run_workflow
    //       resolves the slug against the live catalog).
    //   (b) otherwise, if `dry_run_workflow` is present → run the current
    //       DRAFT. This is the gate-safe target: the gate never removes
    //       `dry_run_workflow` (see authoring-palette `applyExecutionToolGate`),
    //       and it preserves the anti-hijack intent — it never runs a
    //       saved lookalike, only the in-progress draft.
    //   (c) neither present → fall through to `unknown_tool` + null.
    // (Production: 3 wf_* hallucinations in one 4h window, plus the
    // draft-run dead-end that spun the repair cap to death.)
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
        // Carry the model's original args verbatim as the draft-run
        // `input`. `dry_run_workflow` accepts `{ input?, environment? }`,
        // so the parsed original arguments become the draft's input.
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
      // Last resort: an execution tool is genuinely absent (gate closed,
      // no draft target) and the model knows a slug. Dead-ending here is
      // what made the chat channel hallucinate a "use the CLI" refusal
      // (prod). `find_workflow` is READ-ONLY, gate-safe, and always in the
      // chat palette — rewrite to it so the model identifies the workflow
      // the user meant and then confirm-and-runs it (per the chat persona's
      // find_workflow → ask_user_confirm rule). Nothing is auto-run.
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
  // Tool.inputSchema may be a Zod schema, a Valibot schema, or a plain
  // JSON-Schema object — widen to `unknown` and let toJsonSchemaShape sort it.
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
      // AI SDK 7 requires opting in to system-role messages inside `messages`.
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

/**
 * Recover the model's original tool arguments as a parsed value. The AI SDK
 * hands `toolCall.input` as a JSON string on the happy path, but a
 * malformed/absent payload may arrive as a non-string or unparseable text.
 * Returns the parsed object when possible, the raw string when it is
 * non-empty but not JSON, and `{}` when there is nothing to carry.
 */
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

/**
 * Derive a `find_workflow` query from a failed bare `run_workflow` call's
 * arguments: the `workflow` slug the model tried to run, kebab→spaces.
 * Returns null when no usable slug is present (nothing to search on).
 */
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

/**
 * Heuristic detector for provider-side structured-output schema
 * rejections. The warn-level emitter attaches the normalised schema
 * fragment (~up to 4KB) only when this fires, so the detector has to
 * be *narrow* — the AI SDK's generic `AI_APICallError` also covers
 * quota/auth/connection failures, where the schema payload would
 * inflate logs without diagnostic value. The dual-key rule:
 *
 *   - `AI_APICallError` + a schema-marker substring → schema rejection
 *   - any other error name + a schema-marker substring → schema rejection
 *     (covers providers that wrap the upstream error differently)
 *   - `AI_APICallError` alone (quota, 429, ECONNRESET, etc.) → NOT a
 *     schema rejection
 *
 * Exported so the heuristic has unit coverage independent of the AI
 * SDK mock surface.
 */
export function isSchemaRejectionError(input: { errName: string; errMsg: string }): boolean {
  return SCHEMA_REJECTION_MARKERS.some((marker) => input.errMsg.includes(marker));
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
    return zodToJsonSchema7(raw as ZodType);
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return null;
}
