// Shared `_meta.subkit` hint builder for MCP tool listings.
//
// Clients (and downstream LLMs) read `_meta.subkit.confirm_required`
// before issuing a tenant.* call. When set, they skip any self-authored
// `ask_user_confirm` dance — the MCP policy gate will raise exactly one
// elicitation on the first call. This removes the "two elicitations for
// one delete" path that a self-authored confirm prompt would otherwise hit.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolCategory } from "../../conversations/tools/index.ts";

/** MCP-standard tool annotations (spec `Tool.annotations`). */
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

/** Conservative "could this ever need confirm?" probe. */
function couldRequireConfirmation(category: ToolCategory, toolName: string): boolean {
  if (category === "tenant_read") return false;
  // Probe the resolver with an empty input — if the tool demands
  // confirm even without concrete args, flag it. This intentionally
  // errs on the side of warning the client: `run_workflow` with
  // `environment:"prod"` would gate but with `"dev"` would not; we
  // advertise `confirm_required: true` so clients surface a warning
  // and drop back to a plain execute when the env actually lands.
  const mode = resolveToolMode({
    tool: toolName,
    category,
    input: {},
    overrides: {},
  });
  return mode === "confirm_before_execution";
}

/** Heuristic for the "destructive" badge — purely cosmetic hint. */
function isDestructive(toolName: string): boolean {
  return /^(delete_|revoke_|archive_|remove_)/.test(toolName);
}

export function buildConversationToolMeta(
  category: ToolCategory,
  toolName: string,
): SubkitToolMetaEnvelope {
  return {
    subkit: {
      category,
      confirm_required: couldRequireConfirmation(category, toolName),
      destructive: isDestructive(toolName),
    },
  };
}

/**
 * MCP-standard `annotations` for a registry/conversation tool.
 *
 * Unlike the vendor `_meta.subkit.*` hints above (which only claude.ai's
 * own surface reads), these live in the spec-defined `Tool.annotations`
 * field that generic MCP clients — notably ChatGPT/codex — read to decide
 * whether a tool may be invoked without an explicit per-call confirmation.
 * With no annotations a strict client must treat every tool as an opaque
 * possibly-mutating action and gates the write-classified authoring tools
 * (e.g. `conversation_start`) on its own surface. Advertising `readOnlyHint`
 * on the read tools and a precise `destructiveHint` on writes gives the
 * client the signal it needs to permit the call.
 */
export function buildToolAnnotations(
  category: ToolCategory | "workflow_run",
  toolName: string,
): McpToolAnnotations {
  const readOnly = category === "tenant_read";
  return {
    readOnlyHint: readOnly,
    destructiveHint: isDestructive(toolName),
    // A pure read never mutates, so it is trivially idempotent. Writes make
    // no such guarantee.
    idempotentHint: readOnly,
  };
}

/**
 * MCP-standard `annotations` for a `wf_<slug>` workflow-run tool. A saved
 * workflow executes its stored steps/connectors — it may write to external
 * systems (sends, commits) but never destroys subkit-tenant data, and prod
 * runs stay confirm-gated by the policy gate. So: not read-only, not
 * destructive, open-world (it reaches external systems).
 */
export function buildWorkflowToolAnnotations(): McpToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
}

export function buildWorkflowToolMeta(): SubkitToolMetaEnvelope {
  // Workflow runs are policy-driven: `run_workflow` is confirm-gated in
  // prod, auto in dev. The MCP dispatch checks `_meta.environment` at
  // call time and the policy gate fires accordingly — we conservatively
  // advertise `confirm_required: true` so a client can warn before a
  // prod run without the LLM having to read tool-policies.ts.
  return {
    subkit: {
      category: "workflow_run",
      confirm_required: true,
      destructive: false,
    },
  };
}
