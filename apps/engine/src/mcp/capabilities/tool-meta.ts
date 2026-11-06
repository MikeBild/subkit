import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolCategory } from "../../tools/types.ts";

export type McpToolAnnotations = NonNullable<Tool["annotations"]>;

export interface SubkitToolMeta {
  category: ToolCategory | "workflow_run";
  confirm_required: boolean;
  destructive: boolean;
}

export interface SubkitToolMetaEnvelope {
  subkit: SubkitToolMeta;
  [k: string]: unknown;
}

const WRITE_DESPITE_READ_CATEGORY: ReadonlySet<string> = new Set([
  "confirm_tool_call",
  "call_connector",
  "authenticate",
  "self_healing_scan",
  "probe_connector",
  "probe_connector_draft",
]);

const ADDITIVE_WRITES: ReadonlySet<string> = new Set([
  "conversation_start",
  "conversation_append",
  "conversation_respond_elicitation",
  "save_learning",
  "propose_workflow_repair",
]);

function advertisedReadOnly(category: ToolCategory | "workflow_run", toolName: string): boolean {
  if (category !== "tenant_read") return false;
  return !WRITE_DESPITE_READ_CATEGORY.has(toolName);
}

function advertisedDestructive(category: ToolCategory | "workflow_run", toolName: string): boolean {
  if (advertisedReadOnly(category, toolName)) return false;
  return !ADDITIVE_WRITES.has(toolName);
}

function couldRequireConfirmation(category: ToolCategory, toolName: string): boolean {
  if (toolName === "confirm_tool_call") return false;
  if (WRITE_DESPITE_READ_CATEGORY.has(toolName)) return true;
  if (category === "tenant_read") return false;
  const mode = resolveToolMode({
    tool: toolName,
    category,
    input: {},
    overrides: {},
  });
  return mode === "confirm_before_execution";
}

const EXTERNAL_REACHING_TOOLS: ReadonlySet<string> = new Set([
  "confirm_tool_call",
  "call_connector",
  "probe_connector",
  "probe_connector_draft",
  "test_connector",
  "fetch_connector_docs",
  "fetch_connector_self_description",
  "manage_service_package_skill",
  "discover_connector_endpoints",
  "authenticate_oauth",
  "request_connector_reauth",
  "dry_run_step",
  "dry_run_workflow",
]);

function reachesExternal(toolName: string): boolean {
  return EXTERNAL_REACHING_TOOLS.has(toolName);
}

const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set(["search_knowledge", "find_skill"]);

export function alwaysLoadTool(toolName: string): boolean {
  return ALWAYS_LOAD_TOOLS.has(toolName);
}

export function buildConversationToolMeta(
  category: ToolCategory,
  toolName: string,
): SubkitToolMetaEnvelope {
  return {
    subkit: {
      category,
      confirm_required: couldRequireConfirmation(category, toolName),
      destructive: advertisedDestructive(category, toolName),
    },
  };
}

export function buildToolAnnotations(
  category: ToolCategory | "workflow_run",
  toolName: string,
): McpToolAnnotations {
  const readOnly = advertisedReadOnly(category, toolName);
  return {
    readOnlyHint: readOnly,
    destructiveHint: advertisedDestructive(category, toolName),
    idempotentHint: readOnly,
    openWorldHint: reachesExternal(toolName),
  };
}

export function buildWorkflowToolAnnotations(
  effect: "read" | "reversible_write" | "irreversible_write" = "irreversible_write",
): McpToolAnnotations {
  const readOnly = effect === "read";
  const reversible = effect === "reversible_write";
  return {
    readOnlyHint: readOnly,
    destructiveHint: effect === "irreversible_write",
    idempotentHint: readOnly || reversible,
    openWorldHint: true,
  };
}

export function buildWorkflowToolMeta(
  effect: "read" | "reversible_write" | "irreversible_write" = "irreversible_write",
): SubkitToolMetaEnvelope {
  return {
    subkit: {
      category: "workflow_run",
      confirm_required: effect !== "read",
      destructive: effect === "irreversible_write",
    },
  };
}
