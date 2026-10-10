import type { DraftDocument } from "../types.ts";
import type { ConversationTool } from "./index.ts";

export const CONNECTOR_AUTHORING_SKILL = "connector-creation-guidance";
export const WORKFLOW_AUTHORING_SKILL = "workflow-authoring";

export const WORKFLOW_TOOL_PREFIX = "wf_";

const ALWAYS_VISIBLE: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_form",
  "ask_user_multi",
  "ask_user_text",
  "cannot_help",
  "discover_connector_endpoints",
  "discover_systems_from_files",
  "fetch_connector_docs",
  "get_raw_result",
  "inspect_authoring_context",
  "list_attachments",
  "list_skills",
  "load_skill",
  "preview_attachment",
  "request_connector_reauth",
  "search_knowledge",
  "suggest_connector_templates",
]);

const RELEVANT_READS: ReadonlySet<string> = new Set([
  "call_connector",
  "get_connector",
  "get_execution",
  "get_workflow",
  "inspect_execution_step",
  "list_connectors",
  "list_executions",
  "list_workflows",
  "probe_connector",
]);

const ALWAYS_AVAILABLE_CLEANUP: ReadonlySet<string> = new Set([
  "analyze_knowledge_source",
  "create_knowledge_source",
  "create_schedule",
  "delete_connector",
  "delete_knowledge_source",
  "delete_schedule",
  "delete_subscription",
  "delete_workflow",
  "restore_workflow_version",
  "revoke_api_key",
  "revoke_portal_token",
  "update_connector",
  "update_knowledge_source",
  "update_schedule",
  "update_subscription",
  "update_workflow",
  "create_intake_proposal",
  "discard_intake_item",
  "restore_intake_item",
  "move_intake_item",
  "set_default_intake_category",
  "revise_intake_proposal",
]);

const CONNECTOR_AUTHORING: ReadonlySet<string> = new Set([
  "inspect_connector_draft",
  "probe_connector_draft",
  "start_connector_from_description",
  "start_connector_from_template",
  "update_connector_draft",
  "validate_connector_draft",
]);

const CONNECTOR_PERSISTENCE: ReadonlySet<string> = new Set(["save_connector_draft"]);

const CONNECTOR_OAUTH: ReadonlySet<string> = new Set(["authenticate_oauth"]);

const WORKFLOW_AUTHORING: ReadonlySet<string> = new Set([
  "author_workflow",
  "edit_workflow_patch",
  "inspect_workflow_draft",
  "open_workflow_draft",
  "start_workflow_from_recipe",
  "validate_draft",
]);

const WORKFLOW_PREVIEW: ReadonlySet<string> = new Set([
  "dry_run_step",
  "dry_run_transform",
  "dry_run_workflow",
]);

const WORKFLOW_PERSISTENCE: ReadonlySet<string> = new Set(["save_workflow_draft"]);

const DIAGNOSIS_TOOLS: ReadonlySet<string> = new Set(["diagnose_latest_execution"]);

const ALWAYS_AVAILABLE_EXECUTION: ReadonlySet<string> = new Set(["run_workflow"]);

export const REVIEW_DECISIONS: ReadonlySet<string> = new Set(["approve_skill_candidate"]);

function addNames(target: Set<string>, names: ReadonlySet<string>): void {
  for (const name of names) target.add(name);
}

export function filterByAuthoringPalette<
  T extends { name: string; category?: ConversationTool["category"]; inert_proposal?: boolean },
>(tools: readonly T[], _draft: DraftDocument, loadedSkills: ReadonlySet<string>): T[] {
  const allowed = new Set<string>();
  addNames(allowed, ALWAYS_VISIBLE);
  addNames(allowed, RELEVANT_READS);
  addNames(allowed, ALWAYS_AVAILABLE_CLEANUP);
  addNames(allowed, ALWAYS_AVAILABLE_EXECUTION);
  addNames(allowed, REVIEW_DECISIONS);

  if (loadedSkills.has(CONNECTOR_AUTHORING_SKILL)) {
    addNames(allowed, CONNECTOR_AUTHORING);
    addNames(allowed, CONNECTOR_PERSISTENCE);
    addNames(allowed, CONNECTOR_OAUTH);
  }
  if (loadedSkills.has(WORKFLOW_AUTHORING_SKILL)) {
    addNames(allowed, WORKFLOW_AUTHORING);
    addNames(allowed, WORKFLOW_PREVIEW);
    addNames(allowed, WORKFLOW_PERSISTENCE);
    addNames(allowed, DIAGNOSIS_TOOLS);
  }
  return tools.filter(
    (tool) =>
      allowed.has(tool.name) || tool.category === "tenant_read" || tool.inert_proposal === true,
  );
}

export const CHAT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_form",
  "ask_user_multi",
  "ask_user_text",
  "cannot_help",
  "list_skills",
  "load_skill",
  "list_attachments",
  "preview_attachment",
  "get_raw_result",
  "search_knowledge",
  "search_docs",
  "list_knowledge_sources",
  "get_knowledge_source",
  "read_knowledge",
  "list_workflows",
  "get_workflow",
  "find_workflow",
  "list_executions",
  "get_execution",
  "inspect_execution",
  "inspect_execution_step",
  "list_connectors",
  "get_connector",
  "find_connector",
  "get_skill",
  "find_skill",
  "list_schedules",
  "review_workflow_automation",
  "run_workflow",
  "list_intake_categories",
  "list_intake_items",
  "get_intake_item",
]);

export function filterByChatReadOnlyPalette<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => CHAT_READONLY_TOOLS.has(tool.name));
}

export interface ExecutionToolGateState {
  hasBoundSavedWorkflow: boolean;
  explicitlyNamedWorkflowSlug: string | null;
}

export interface ExecutionToolGateDecision {
  exposeExecution: boolean;
  reason:
    | "bound_saved_workflow"
    | "named_workflow_slug"
    | "chat_surface"
    | "explicit_no_run"
    | "authoring_no_target";
}

export function resolveExecutionToolGate(state: ExecutionToolGateState): ExecutionToolGateDecision {
  if (state.hasBoundSavedWorkflow) {
    return { exposeExecution: true, reason: "bound_saved_workflow" };
  }
  if (state.explicitlyNamedWorkflowSlug != null) {
    return { exposeExecution: true, reason: "named_workflow_slug" };
  }
  return { exposeExecution: false, reason: "authoring_no_target" };
}

export function isExecutionToolName(
  name: string,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): boolean {
  if (name === "run_workflow") return true;
  if (!name.startsWith(WORKFLOW_TOOL_PREFIX)) return false;
  return syntheticWorkflowSlugs.has(name.slice(WORKFLOW_TOOL_PREFIX.length));
}

const MIN_SINGLE_TOKEN_SLUG_LENGTH = 6;

function isNameableSlug(slug: string): boolean {
  if (slug.length < 4) return false;
  if (slug.includes("-")) return true;
  return slug.length >= MIN_SINGLE_TOKEN_SLUG_LENGTH;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveNamedWorkflowSlug(
  message: string | null | undefined,
  slugCatalog: ReadonlySet<string>,
): string | null {
  if (!message) return null;
  for (const slug of slugCatalog) {
    if (!isNameableSlug(slug)) continue;
    const re = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(slug.toLowerCase())}([^a-z0-9-]|$)`, "i");
    if (re.test(message)) return slug;
  }
  return null;
}

export function collectSyntheticWorkflowSlugs(toolNames: Iterable<string>): Set<string> {
  const slugs = new Set<string>();
  for (const name of toolNames) {
    if (name.startsWith(WORKFLOW_TOOL_PREFIX)) {
      slugs.add(name.slice(WORKFLOW_TOOL_PREFIX.length));
    }
  }
  return slugs;
}

export function applyExecutionToolGate(
  tools: Record<string, unknown>,
  decision: ExecutionToolGateDecision,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): number {
  if (decision.exposeExecution) return 0;
  let removed = 0;
  for (const name of Object.keys(tools)) {
    if (isExecutionToolName(name, syntheticWorkflowSlugs)) {
      delete tools[name];
      removed += 1;
    }
  }
  return removed;
}
