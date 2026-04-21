// Shared `_meta.subkit` hint builder for MCP tool listings.
//
// Clients (and downstream LLMs) read `_meta.subkit.confirm_required`
// before issuing a tenant.* call. When set, they skip any self-authored
// `ask_user_confirm` dance — the MCP policy gate will raise exactly one
// elicitation on the first call. This removes the "two elicitations for
// one delete" path the April 21 Codex session exposed.

import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolCategory } from "../../conversations/tools/index.ts";

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
