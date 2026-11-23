import type { TranslationKey } from "./i18n";

type ToolTier = "background" | "action";

const WORKFLOW_TOOL_PREFIX = "wf_";

interface BackgroundWords {
  active: TranslationKey;
  past: TranslationKey;
}

const BACKGROUND_TOOLS: Record<string, BackgroundWords> = {
  export_diagnostic_context: {
    active: "tool.background.exportDiagnosticContext.active",
    past: "tool.background.exportDiagnosticContext.past",
  },
  export_tenant_package: {
    active: "tool.background.exportTenantPackage.active",
    past: "tool.background.exportTenantPackage.past",
  },
  preview_package_import: {
    active: "tool.background.previewPackageImport.active",
    past: "tool.background.previewPackageImport.past",
  },
  inspect_playbook: {
    active: "tool.background.inspectPlaybook.active",
    past: "tool.background.inspectPlaybook.past",
  },
  update_playbook: {
    active: "tool.background.updatePlaybook.active",
    past: "tool.background.updatePlaybook.past",
  },
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
  list_tasks: {
    active: "tool.background.listTasks.active",
    past: "tool.background.listTasks.past",
  },
  find_task: {
    active: "tool.background.findTask.active",
    past: "tool.background.findTask.past",
  },
  get_task: { active: "tool.background.getTask.active", past: "tool.background.getTask.past" },
  get_task_run: {
    active: "tool.background.getTaskRun.active",
    past: "tool.background.getTaskRun.past",
  },
};

const ACTION_TOOLS: Record<string, TranslationKey> = {
  run_workflow: "tool.name.runWorkflow",
  dry_run_workflow: "tool.name.dryRunWorkflow",
  dry_run_step: "tool.name.dryRunStep",
  dry_run_transform: "tool.name.dryRunTransform",
  author_workflow: "tool.name.authorWorkflow",
  edit_workflow_patch: "tool.name.editWorkflowPatch",
  open_workflow_draft: "tool.name.openWorkflowDraft",
  save_workflow_draft: "tool.name.saveWorkflowDraft",
  validate_draft: "tool.name.validateDraft",
  update_workflow: "tool.name.updateWorkflow",
  delete_workflow: "tool.name.deleteWorkflow",
  restore_workflow_version: "tool.name.restoreWorkflowVersion",
  apply_package_import: "tool.name.applyPackageImport",
  start_workflow_from_recipe: "tool.name.startWorkflowFromRecipe",
  approve_patch_candidate: "tool.name.approvePatchCandidate",
  dry_run_patch_candidate: "tool.name.dryRunPatchCandidate",
  approve_skill_candidate: "tool.name.approveSkillCandidate",
  reject_skill_candidate: "tool.name.rejectSkillCandidate",
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
  enroll_service_package_connector: "tool.name.enrollServicePackageConnector",
  fetch_connector_self_description: "tool.name.fetchConnectorSelfDescription",
  prepare_service_package_workflow: "tool.name.prepareServicePackageWorkflow",
  manage_service_package_workflow: "tool.name.manageServicePackageWorkflow",
  manage_service_package_skill: "tool.name.manageServicePackageSkill",
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
  run_task: "tool.name.runTask",
  abort_task_run: "tool.name.abortTaskRun",
  save_task: "tool.name.saveTask",
  schedule_task_check: "tool.name.scheduleTaskCheck",
};

export function workflowSlugFromTool(toolName: string): string | null {
  if (!toolName.startsWith(WORKFLOW_TOOL_PREFIX)) return null;
  const slug = toolName.slice(WORKFLOW_TOOL_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

export function humaniseToolName(toolName: string): string {
  return toolName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

export function toolTier(toolName: string): ToolTier {
  if (workflowSlugFromTool(toolName)) return "action";
  if (toolName in BACKGROUND_TOOLS) return "background";
  return "action";
}

type ToolLabel =
  | { kind: "workflow"; slug: string }
  | { kind: "key"; key: TranslationKey }
  | { kind: "background"; words: BackgroundWords }
  | { kind: "literal"; text: string };

const PROPOSED_SKILL_ACTIONS: ReadonlySet<unknown> = new Set(["proposed", "updated"]);

function outcomeActionKey(toolName: string, output: unknown): TranslationKey | null {
  if (toolName !== "create_skill") return null;
  return PROPOSED_SKILL_ACTIONS.has(runPayload(output)?.action) ? "tool.name.proposeSkill" : null;
}

export function toolLabel(toolName: string, output?: unknown): ToolLabel {
  const slug = workflowSlugFromTool(toolName);
  if (slug) return { kind: "workflow", slug };
  const background = BACKGROUND_TOOLS[toolName];
  if (background) return { kind: "background", words: background };
  const action = outcomeActionKey(toolName, output) ?? ACTION_TOOLS[toolName];
  if (action) return { kind: "key", key: action };
  return { kind: "literal", text: humaniseToolName(toolName) };
}

export type WorkflowRunKind = "live" | "read" | "trial" | "refused";

function runPayload(output: unknown): Record<string, unknown> | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const outer = output as Record<string, unknown>;
  const inner = outer.data;
  return inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? { ok: outer.ok, ...(inner as Record<string, unknown>) }
    : outer;
}

export function isWorkflowRunTool(toolName: string): boolean {
  return workflowSlugFromTool(toolName) !== null || toolName === "run_workflow";
}

export function workflowRunKind(output: unknown): WorkflowRunKind | null {
  const payload = runPayload(output);
  if (!payload) return null;
  if (payload.tool_effect === "read" && typeof payload.execution_id === "string") return "read";
  if (payload.hold_writes === true || payload.writes_held === true || payload.preview === true)
    return "trial";
  if (typeof payload.execution_id === "string" && payload.execution_id) return "live";
  if (
    typeof payload.error_code === "string" ||
    typeof payload.error === "string" ||
    payload.denied === true ||
    payload.ok === false
  )
    return "refused";
  return null;
}

const REFUSAL_WORDS: Record<string, TranslationKey> = {
  workflow_activation_required: "tool.refusal.activationRequired",
  workflow_version_invalid: "tool.refusal.legacy",
  workflow_not_persisted: "tool.refusal.notSaved",
  workflow_not_found: "tool.refusal.notFound",
  workflow_archived: "tool.refusal.archived",
  permission_denied: "tool.refusal.permission",
  principal_required: "tool.refusal.permission",
  repair_loop_detected: "tool.refusal.repeatedFailure",
  input_schema_violation: "tool.refusal.input",
  execution_authority_required: "tool.refusal.approval",
  execution_authority_unavailable: "tool.refusal.approval",
  execution_authority_changed: "tool.refusal.approval",
  task_run_use_workflow_tool: "tool.refusal.ownTool",
};

export type WorkflowResultLink = { url: string; expiresAt: string };

export function liveRunExecutionId(output: unknown): string | null {
  if (workflowRunKind(output) !== "live") return null;
  const id = runPayload(output)?.execution_id;
  return typeof id === "string" && id ? id : null;
}

export function workflowResultLink(output: unknown): WorkflowResultLink | null {
  const result = runPayload(output)?.output;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const { url, expires_at: expiresAt } = result as Record<string, unknown>;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  return { url, expiresAt };
}

export function workflowRefusalKey(output: unknown): TranslationKey | null {
  const payload = runPayload(output);
  if (!payload) return null;
  if (payload.denied === true) return "tool.refusal.permission";
  const code = typeof payload.error_code === "string" ? payload.error_code : payload.error;
  return typeof code === "string" ? (REFUSAL_WORDS[code] ?? null) : null;
}

export function workflowRunTitleKey(
  label: ToolLabel,
  notRun: boolean,
  kind: WorkflowRunKind | null,
): TranslationKey | null {
  const named = label.kind === "workflow";
  if (!named && !(label.kind === "key" && label.key === "tool.name.runWorkflow")) return null;
  if (notRun) return named ? "tool.name.runNamedWorkflow.notRun" : "tool.name.runWorkflow.notRun";
  if (kind === "read")
    return named ? "tool.name.runNamedWorkflow.read" : "tool.name.runWorkflow.read";
  if (kind === "trial")
    return named ? "tool.name.runNamedWorkflow.trial" : "tool.name.runWorkflow.trial";
  if (kind === "refused")
    return named ? "tool.name.runNamedWorkflow.refused" : "tool.name.runWorkflow.refused";
  return named ? "tool.name.runNamedWorkflow" : "tool.name.runWorkflow";
}

type ToolOutcomeInput = {
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

export function toolOutcomeKey(input: ToolOutcomeInput): TranslationKey | null {
  if (input.stale) return "tool.outcome.didNotComplete";
  const confirmation = input.confirmationState
    ? CONFIRMATION_WORDS[input.confirmationState]
    : undefined;
  if (confirmation) return confirmation;
  const outcome = input.outcome ? OUTCOME_WORDS[input.outcome] : undefined;
  return outcome ?? null;
}

export const STALE_AFTER_MS = 5 * 60 * 1000;

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
