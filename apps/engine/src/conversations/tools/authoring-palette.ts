import { REVIEW_DECISIONS } from "../../llm/runtime/step-router.ts";
import {
  detectAuthoringIntent,
  detectConnectorAuthoringIntent,
  detectRepairIntent,
} from "../loop/authoring-intent.ts";
import { nextRecommendedAction } from "../onboarding-policy.ts";
import type { AuthoringStage, DraftDocument } from "../types.ts";
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
  "export_diagnostic_context",
  "inspect_playbook",
  "update_playbook",
  "list_attachments",
  "list_skills",
  "switch_authoring_focus",
  "load_skill",
  "open_workflow_draft",
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
  "apply_package_import",
  "create_knowledge_source",
  "create_schedule",
  "delete_connector",
  "delete_knowledge_source",
  "delete_schedule",
  "delete_subscription",
  "delete_workflow",
  "export_tenant_package",
  "restore_workflow_version",
  "revoke_api_key",
  "revoke_portal_token",
  "update_connector",
  "update_knowledge_source",
  "update_schedule",
  "update_subscription",
  "update_workflow",
  "create_intake_proposal",
  "discard_intake_items",
  "restore_intake_item",
  "move_intake_item",
  "set_default_intake_category",
  "revise_intake_proposal",
]);

const CONNECTOR_AUTHORING: ReadonlySet<string> = new Set([
  "inspect_connector_draft",
  "enroll_service_package_connector",
  "manage_service_package_skill",
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
  "manage_service_package_workflow",
  "prepare_service_package_workflow",
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
const LIVE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(["run_workflow", "rerun_execution"]);

const HELD_PREVIEW_TOOLS: ReadonlySet<string> = new Set(["dry_run_workflow", "dry_run_step"]);

const WORKFLOW_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  ...LIVE_EXECUTION_TOOLS,
  ...HELD_PREVIEW_TOOLS,
]);

const SKILL_UNLOCKS: ReadonlyArray<{ skill: string; tools: ReadonlyArray<ReadonlySet<string>> }> = [
  {
    skill: CONNECTOR_AUTHORING_SKILL,
    tools: [CONNECTOR_AUTHORING, CONNECTOR_PERSISTENCE, CONNECTOR_OAUTH],
  },
  {
    skill: WORKFLOW_AUTHORING_SKILL,
    tools: [WORKFLOW_AUTHORING, WORKFLOW_PREVIEW, WORKFLOW_PERSISTENCE, DIAGNOSIS_TOOLS],
  },
];

export function lockedToolsBySkill(
  loadedSkills: ReadonlySet<string>,
): Array<{ skill: string; tools: string[] }> {
  return SKILL_UNLOCKS.filter(({ skill }) => !loadedSkills.has(skill)).map(({ skill, tools }) => ({
    skill,
    tools: tools.flatMap((names) => [...names]),
  }));
}

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

  for (const { skill, tools: unlocked } of SKILL_UNLOCKS) {
    if (loadedSkills.has(skill)) for (const names of unlocked) addNames(allowed, names);
  }
  return tools.filter(
    (tool) =>
      allowed.has(tool.name) || tool.category === "tenant_read" || tool.inert_proposal === true,
  );
}

interface AuthoringTurnSignals {
  surface: string | undefined;
  draft: DraftDocument;
  userMessage: string | null | undefined;
  startNewWorkflow: boolean;
  boundConnector: boolean;
  boundWorkflow: boolean;
}

export function authoringSkillsForTurn(signals: AuthoringTurnSignals): string[] {
  if (signals.surface === "chat") return [];
  const nextAction = nextRecommendedAction({ draft: signals.draft }).kind;
  const target = signals.draft.summary?.active_target.kind;
  const skills: string[] = [];
  if (
    nextAction.startsWith("connector_") ||
    target === "connector" ||
    detectConnectorAuthoringIntent(signals.userMessage)
  ) {
    skills.push(CONNECTOR_AUTHORING_SKILL);
  }
  if (
    nextAction.startsWith("workflow_") ||
    target === "workflow" ||
    typeof signals.draft.connector?.saved_connector_id === "string" ||
    signals.boundConnector ||
    signals.boundWorkflow ||
    signals.startNewWorkflow ||
    detectAuthoringIntent(signals.userMessage) ||
    detectRepairIntent(signals.userMessage)
  ) {
    skills.push(WORKFLOW_AUTHORING_SKILL);
  }
  return skills;
}

export const CHAT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "inspect_playbook",
  "update_playbook",
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
  explicitExternalAction?: boolean;
  authoringInProgress?: boolean;
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  suppressExecution?: boolean;
  suppressLiveExecution?: boolean;
}

export interface ExecutionToolGateDecision {
  exposeExecution: boolean;
  reason:
    | "bound_saved_workflow"
    | "named_workflow_slug"
    | "requested_saved_workflow_action"
    | "no_authoring_signal"
    | "chat_surface"
    | "explicit_no_run"
    | "explicit_no_live_effects"
    | "authoring_no_target";
}

const SETTLED_STAGES: ReadonlySet<AuthoringStage> = new Set([
  "idle",
  "connector_persisted",
  "workflow_persisted",
  "workflow_executed",
]);

export function authoringStageOpen(stage: AuthoringStage | undefined): boolean {
  return stage !== undefined && !SETTLED_STAGES.has(stage);
}

export function resolveExecutionToolGate(state: ExecutionToolGateState): ExecutionToolGateDecision {
  if (state.suppressExecution) {
    return { exposeExecution: false, reason: "explicit_no_run" };
  }
  const decision = resolveExposure(state);
  return decision.exposeExecution && state.suppressLiveExecution
    ? { exposeExecution: false, reason: "explicit_no_live_effects" }
    : decision;
}

function resolveExposure(state: ExecutionToolGateState): ExecutionToolGateDecision {
  if (state.surface === "chat") {
    return { exposeExecution: true, reason: "chat_surface" };
  }
  if (state.hasBoundSavedWorkflow) {
    return { exposeExecution: true, reason: "bound_saved_workflow" };
  }
  if (state.explicitlyNamedWorkflowSlug != null) {
    return { exposeExecution: true, reason: "named_workflow_slug" };
  }
  if (state.explicitExternalAction) {
    return { exposeExecution: true, reason: "requested_saved_workflow_action" };
  }
  if (state.authoringInProgress === false) {
    return { exposeExecution: true, reason: "no_authoring_signal" };
  }
  return { exposeExecution: false, reason: "authoring_no_target" };
}

export function isExecutionToolName(
  name: string,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): boolean {
  if (WORKFLOW_EXECUTION_TOOLS.has(name)) return true;
  if (!name.startsWith(WORKFLOW_TOOL_PREFIX)) return false;
  return syntheticWorkflowSlugs.has(name.slice(WORKFLOW_TOOL_PREFIX.length));
}

export function isLiveExecutionTool(name: string): boolean {
  return LIVE_EXECUTION_TOOLS.has(name) || name.startsWith(WORKFLOW_TOOL_PREFIX);
}

export function isWorkflowExecutionTool(name: string): boolean {
  return WORKFLOW_EXECUTION_TOOLS.has(name) || name.startsWith(WORKFLOW_TOOL_PREFIX);
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

function keepsHeldPreview(reason: ExecutionToolGateDecision["reason"]): boolean {
  return reason === "authoring_no_target" || reason === "explicit_no_live_effects";
}

export function applyExecutionToolGate(
  tools: Record<string, unknown>,
  decision: ExecutionToolGateDecision,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): number {
  if (decision.exposeExecution) return 0;
  let removed = 0;
  for (const name of Object.keys(tools)) {
    if (HELD_PREVIEW_TOOLS.has(name) && keepsHeldPreview(decision.reason)) continue;
    if (isExecutionToolName(name, syntheticWorkflowSlugs)) {
      delete tools[name];
      removed += 1;
    }
  }
  return removed;
}
