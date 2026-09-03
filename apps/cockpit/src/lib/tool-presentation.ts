import type { TranslationKey } from "./i18n";

// What a governed action is called, and how it ended.
//
// Every card in the transcript used to read the same three words. `ToolHeader`
// destructured `toolName` and never used it, and no caller passed a `title`, so
// a person watching an agent work saw a column of identical rows and could not
// tell a catalogue lookup from a workflow that actually ran.
//
// Two tiers, because those two are not the same event. A read that costs
// nothing and changes nothing is background noise and belongs on one line; a
// call that runs something, spends something or asks for a decision deserves a
// card. An unrecognised action defaults to a card: showing one action too
// prominently is a smaller failure than hiding one that mattered.

export type ToolTier = "background" | "action";

/** Prefix the engine gives a saved workflow exposed as a callable action. */
const WORKFLOW_TOOL_PREFIX = "wf_";

/**
 * Reads and lookups. Each carries two words — one for while it runs, one for
 * afterwards — because "Searching knowledge…" and "Searched knowledge" are
 * different statements and a shimmering line has to make both.
 */
interface BackgroundWords {
  active: TranslationKey;
  past: TranslationKey;
}

const BACKGROUND_TOOLS: Record<string, BackgroundWords> = {
  list_workflows: {
    active: "tool.background.listWorkflows.active",
    past: "tool.background.listWorkflows.past",
  },
  list_executions: {
    active: "tool.background.listExecutions.active",
    past: "tool.background.listExecutions.past",
  },
  list_connectors: {
    active: "tool.background.listConnectors.active",
    past: "tool.background.listConnectors.past",
  },
  list_skills: {
    active: "tool.background.listSkills.active",
    past: "tool.background.listSkills.past",
  },
  list_knowledge_sources: {
    active: "tool.background.listKnowledgeSources.active",
    past: "tool.background.listKnowledgeSources.past",
  },
  list_schedules: {
    active: "tool.background.listSchedules.active",
    past: "tool.background.listSchedules.past",
  },
  list_attachments: {
    active: "tool.background.listAttachments.active",
    past: "tool.background.listAttachments.past",
  },
  find_workflow: {
    active: "tool.background.findWorkflow.active",
    past: "tool.background.findWorkflow.past",
  },
  find_connector: {
    active: "tool.background.findConnector.active",
    past: "tool.background.findConnector.past",
  },
  find_skill: {
    active: "tool.background.findSkill.active",
    past: "tool.background.findSkill.past",
  },
  get_workflow: {
    active: "tool.background.getWorkflow.active",
    past: "tool.background.getWorkflow.past",
  },
  get_connector: {
    active: "tool.background.getConnector.active",
    past: "tool.background.getConnector.past",
  },
  get_execution: {
    active: "tool.background.getExecution.active",
    past: "tool.background.getExecution.past",
  },
  get_knowledge_source: {
    active: "tool.background.getKnowledgeSource.active",
    past: "tool.background.getKnowledgeSource.past",
  },
  get_skill: { active: "tool.background.getSkill.active", past: "tool.background.getSkill.past" },
  get_raw_result: {
    active: "tool.background.getRawResult.active",
    past: "tool.background.getRawResult.past",
  },
  get_engine_status: {
    active: "tool.background.getEngineStatus.active",
    past: "tool.background.getEngineStatus.past",
  },
  inspect_workflow_draft: {
    active: "tool.background.inspectWorkflowDraft.active",
    past: "tool.background.inspectWorkflowDraft.past",
  },
  inspect_connector_draft: {
    active: "tool.background.inspectConnectorDraft.active",
    past: "tool.background.inspectConnectorDraft.past",
  },
  inspect_authoring_context: {
    active: "tool.background.inspectAuthoringContext.active",
    past: "tool.background.inspectAuthoringContext.past",
  },
  inspect_execution: {
    active: "tool.background.inspectExecution.active",
    past: "tool.background.inspectExecution.past",
  },
  inspect_execution_step: {
    active: "tool.background.inspectExecutionStep.active",
    past: "tool.background.inspectExecutionStep.past",
  },
  search_knowledge: {
    active: "tool.background.searchKnowledge.active",
    past: "tool.background.searchKnowledge.past",
  },
  search_docs: {
    active: "tool.background.searchDocs.active",
    past: "tool.background.searchDocs.past",
  },
  read_knowledge: {
    active: "tool.background.readKnowledge.active",
    past: "tool.background.readKnowledge.past",
  },
  load_skill: {
    active: "tool.background.loadSkill.active",
    past: "tool.background.loadSkill.past",
  },
  preview_attachment: {
    active: "tool.background.previewAttachment.active",
    past: "tool.background.previewAttachment.past",
  },
  fetch_connector_docs: {
    active: "tool.background.fetchConnectorDocs.active",
    past: "tool.background.fetchConnectorDocs.past",
  },
  suggest_connector_templates: {
    active: "tool.background.suggestConnectorTemplates.active",
    past: "tool.background.suggestConnectorTemplates.past",
  },
};

/** Actions worth a card of their own: they run, change or ask. */
const ACTION_TOOLS: Record<string, TranslationKey> = {
  run_workflow: "tool.name.runWorkflow",
  dry_run_workflow: "tool.name.dryRunWorkflow",
  dry_run_step: "tool.name.dryRunStep",
  dry_run_transform: "tool.name.dryRunTransform",
  author_workflow: "tool.name.authorWorkflow",
  edit_workflow_patch: "tool.name.editWorkflowPatch",
  save_workflow_draft: "tool.name.saveWorkflowDraft",
  update_workflow: "tool.name.updateWorkflow",
  delete_workflow: "tool.name.deleteWorkflow",
  restore_workflow_version: "tool.name.restoreWorkflowVersion",
  start_workflow_from_recipe: "tool.name.startWorkflowFromRecipe",
  approve_patch_candidate: "tool.name.approvePatchCandidate",
  dry_run_patch_candidate: "tool.name.dryRunPatchCandidate",
  approve_skill_candidate: "tool.name.approveSkillCandidate",
  approve_discovery_artifact: "tool.name.approveDiscoveryArtifact",
  call_connector: "tool.name.callConnector",
  probe_connector: "tool.name.probeConnector",
  probe_connector_draft: "tool.name.probeConnectorDraft",
  save_connector_draft: "tool.name.saveConnectorDraft",
  update_connector: "tool.name.updateConnector",
  update_connector_draft: "tool.name.updateConnectorDraft",
  validate_connector_draft: "tool.name.validateConnectorDraft",
  delete_connector: "tool.name.deleteConnector",
  start_connector_from_template: "tool.name.startConnectorFromTemplate",
  start_connector_from_description: "tool.name.startConnectorFromDescription",
  discover_connector_endpoints: "tool.name.discoverConnectorEndpoints",
  discover_systems_from_files: "tool.name.discoverSystemsFromFiles",
  authenticate_oauth: "tool.name.authenticateOauth",
  request_connector_reauth: "tool.name.requestConnectorReauth",
  create_schedule: "tool.name.createSchedule",
  update_schedule: "tool.name.updateSchedule",
  delete_schedule: "tool.name.deleteSchedule",
  create_knowledge_source: "tool.name.createKnowledgeSource",
  update_knowledge_source: "tool.name.updateKnowledgeSource",
  delete_knowledge_source: "tool.name.deleteKnowledgeSource",
  analyze_knowledge_source: "tool.name.analyzeKnowledgeSource",
  create_skill: "tool.name.createSkill",
  propose_skill: "tool.name.proposeSkill",
  delete_skill: "tool.name.deleteSkill",
  save_learning: "tool.name.saveLearning",
  create_api_key: "tool.name.createApiKey",
  revoke_api_key: "tool.name.revokeApiKey",
  revoke_portal_token: "tool.name.revokePortalToken",
  diagnose_latest_execution: "tool.name.diagnoseLatestExecution",
  cannot_help: "tool.name.cannotHelp",
  ask_user_text: "tool.name.askUser",
  ask_user_choice: "tool.name.askUser",
  ask_user_multi: "tool.name.askUser",
  ask_user_form: "tool.name.askUser",
  ask_user_confirm: "tool.name.askUserConfirm",
};

/**
 * The registry key for a tool name.
 *
 * A trailing version is not a different action: `search_knowledge_v2` is the
 * same lookup as `search_knowledge`, and treating it as unregistered dropped it
 * out of the background tier and gave it a card of its own.
 */
function registryKey(toolName: string): string {
  return toolName.replace(/_v\d+$/, "");
}

/** The saved workflow behind a `wf_<slug>` action, or null. */
export function workflowSlugFromTool(toolName: string): string | null {
  if (!toolName.startsWith(WORKFLOW_TOOL_PREFIX)) return null;
  const slug = toolName.slice(WORKFLOW_TOOL_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

/**
 * Last-resort reading of a name nobody registered.
 *
 * The trailing-version strip matters: without it `search_knowledge_v2` reads as
 * "Search Knowledge V2", which tells a person about our versioning rather than
 * about what happened.
 */
export function humaniseToolName(toolName: string): string {
  return toolName
    .replace(/_v\d+$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

export function toolTier(toolName: string): ToolTier {
  if (workflowSlugFromTool(toolName)) return "action";
  if (registryKey(toolName) in BACKGROUND_TOOLS) return "background";
  return "action";
}

export type ToolLabel =
  | { kind: "workflow"; slug: string }
  | { kind: "key"; key: TranslationKey }
  | { kind: "background"; words: BackgroundWords }
  | { kind: "literal"; text: string };

/**
 * How this action should be named.
 *
 * A `wf_<slug>` slug is already a speaking name chosen by whoever saved the
 * workflow, so it is passed through rather than humanised — humanising it would
 * turn `ga4-daily-report` into "Ga4 Daily Report", which reads like a mangling
 * of a name rather than the name itself.
 */
export function toolLabel(toolName: string): ToolLabel {
  const slug = workflowSlugFromTool(toolName);
  if (slug) return { kind: "workflow", slug };
  const key = registryKey(toolName);
  const background = BACKGROUND_TOOLS[key];
  if (background) return { kind: "background", words: background };
  const action = ACTION_TOOLS[key];
  if (action) return { kind: "key", key: action };
  return { kind: "literal", text: humaniseToolName(toolName) };
}

/**
 * How the engine says a call ended.
 *
 * `confirmation_state` is the persisted human decision; `outcome` is the
 * persisted machine result. Both come off the conversation detail, so a
 * reloaded transcript reports the same ending the live one did.
 */
export type ToolOutcomeInput = {
  confirmationState?: string | null | undefined;
  outcome?: string | null | undefined;
  stale?: boolean;
};

const CONFIRMATION_WORDS: Record<string, TranslationKey> = {
  proposed: "tool.outcome.awaitingApproval",
  tested: "tool.outcome.tested",
  confirmed: "tool.outcome.approved",
  partial: "tool.outcome.partlyApproved",
  declined: "tool.outcome.declined",
  auto_declined: "tool.outcome.autoDeclined",
  expired: "tool.outcome.expired",
  oauth_success: "tool.outcome.signInCompleted",
  oauth_failure: "tool.outcome.signInFailed",
};

const OUTCOME_WORDS: Record<string, TranslationKey> = {
  ok: "tool.outcome.done",
  error: "tool.outcome.foundIssue",
  denied: "tool.outcome.denied",
  pending: "tool.outcome.waiting",
};

/**
 * The word for how a call ended, or null to fall back to the part's own state.
 *
 * A human decision outranks the machine result: an operator who declined a call
 * cares that they declined it, not that the engine then reported nothing ran.
 */
export function toolOutcomeKey(input: ToolOutcomeInput): TranslationKey | null {
  if (input.stale) return "tool.outcome.didNotComplete";
  const confirmation = input.confirmationState
    ? CONFIRMATION_WORDS[input.confirmationState]
    : undefined;
  if (confirmation) return confirmation;
  const outcome = input.outcome ? OUTCOME_WORDS[input.outcome] : undefined;
  return outcome ?? null;
}

/** How long a call may sit without a result before it is presumed lost. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * True when a call will never report back.
 *
 * A stream that dies mid-call leaves a row with no result and no error, which
 * renders as a card that is permanently "running" — so the transcript claims
 * work is in progress days later. The anchor is the parent message's timestamp
 * because the persisted part carries none of its own.
 */
export function isStaleCall(args: {
  messageCreatedAt: string | null | undefined;
  hasResult: boolean;
  isStreaming: boolean;
  now: number;
}): boolean {
  if (args.hasResult || args.isStreaming) return false;
  if (!args.messageCreatedAt) return false;
  const started = Date.parse(args.messageCreatedAt);
  if (Number.isNaN(started)) return false;
  return args.now - started > STALE_AFTER_MS;
}
