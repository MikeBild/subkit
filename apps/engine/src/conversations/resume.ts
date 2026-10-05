import { refreshDraftSummary, WORKFLOW_BINDING_TOOL } from "./authoring-state.ts";
import type { ResumeFormField } from "./resume-form.ts";
import { resumeFormFields } from "./resume-form.ts";
import type { ConversationRecord, DraftDocument, WorkflowDraftPreviewSummary } from "./types.ts";

type ConnectorProbe = NonNullable<NonNullable<DraftDocument["connector"]>["latest_probe"]>;

export interface ResumeSummary {
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
  };
  stage: string;
  focused_run: {
    execution_id: string;
    status: string;
    recorded_at: string;
  } | null;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_call_id?: string | null;
    tool_name: string;
    prompt?: {
      question: string;
      intent_kind?: string;
      authorization_url?: string;
      fields?: ResumeFormField[];
      external_tool?: ExternalToolSubject;
      effect?: ConnectorCallSubject;
    };
    summary: string;
    expires_at: string;
  } | null;
  next_action: string;
  one_sentence: string;
}

export interface BuildResumeSummaryParams {
  conversation: ConversationRecord;
  draft: DraftDocument | null | undefined;
  pendingElicitation?: {
    id: string;
    tool_call_id?: string | null;
    tool_name: string;
    input?: unknown;
    summary?: string | null;
    expires_at: string;
  } | null;
}

export function shouldShowResumeSummary(params: BuildResumeSummaryParams): boolean {
  const { conversation, draft } = params;
  if (conversation.status === "committed" || conversation.status === "abandoned") return false;
  if (params.pendingElicitation) return true;
  if (!draft) return false;
  const hasConnectorDraft = draft.connector !== undefined && draft.connector !== null;
  const hasWorkflowSteps = draft.workflow.steps.length > 0;
  const hasPreview = draft.latest_preview !== null && draft.latest_preview !== undefined;
  const hasProbe =
    draft.connector?.latest_probe !== null && draft.connector?.latest_probe !== undefined;
  return hasConnectorDraft || hasWorkflowSteps || hasPreview || hasProbe;
}

export function buildResumeSummary(params: BuildResumeSummaryParams): ResumeSummary {
  const { conversation, draft } = params;
  const d: Partial<DraftDocument> = draft ? refreshDraftSummary(draft) : {};
  const workflowPersisted =
    d.summary?.checkpoints.some(
      (checkpoint) =>
        checkpoint.key === "workflow_persisted" &&
        checkpoint.status === "fresh" &&
        checkpoint.ok === true,
    ) ?? false;
  const openedOnly =
    d.state?.checkpoints.workflow_persisted?.verified_by_tool === WORKFLOW_BINDING_TOOL;
  const workflowSaved = workflowPersisted && !openedOnly;
  const workflowOpen = workflowPersisted && openedOnly;
  const latestRun = d.state?.latest_execution ?? null;
  const focusedRun =
    workflowOpen &&
    latestRun &&
    (!conversation.target_workflow_id || latestRun.workflow_id === conversation.target_workflow_id)
      ? {
          execution_id: latestRun.execution_id,
          status: latestRun.status,
          recorded_at: latestRun.recorded_at,
        }
      : null;
  const connector = d.connector ?? null;
  const connectorSaved = typeof connector?.saved_connector_id === "string";
  const workflow = d.workflow;
  const workflowSteps = workflow?.steps.length ?? 0;
  const hasWorkflow = workflowSteps > 0;

  let activeKind: "connector" | "workflow" | "none" = "none";
  let targetName: string | null = null;
  let targetSlug: string | null = null;
  let targetId: string | null = null;
  let environment: string | null = null;

  if (connector && !connectorSaved) {
    activeKind = "connector";
    targetName = connector.name ?? null;
    targetSlug = connector.slug ?? null;
    environment = connector.environment ?? null;
  } else if (hasWorkflow) {
    activeKind = "workflow";
    targetName = workflow?.name ?? null;
    targetSlug = workflow?.slug ?? null;
    targetId = conversation.target_workflow_id ?? null;
  } else if (connectorSaved) {
    activeKind = "connector";
    targetName = connector?.name ?? null;
    targetSlug = connector?.slug ?? null;
    targetId = conversation.target_connector_id ?? null;
    environment = connector?.environment ?? null;
  }

  const probe = connector?.latest_probe ?? null;
  const lastProbe =
    probe && probe.ok === true
      ? `${probe.method ?? "GET"} ${probe.path ?? "/"} → ${probe.status_code ?? "ok"}`
      : null;
  const previewCheckpoint = d.summary?.checkpoints.find(
    (checkpoint) => checkpoint.key === "workflow_previewed",
  );
  const preview = previewCheckpoint?.status === "stale" ? null : (d.latest_preview ?? null);
  const lastPreview = preview && preview.ok === true ? preview.summary : null;

  const pendingElicitation = params.pendingElicitation ?? null;
  const pendingApproval = pendingElicitation
    ? {
        id: pendingElicitation.id,
        ...(pendingElicitation.tool_call_id !== undefined
          ? { tool_call_id: pendingElicitation.tool_call_id }
          : {}),
        tool_name: pendingElicitation.tool_name,
        summary: pendingElicitation.summary ?? "",
        ...pendingPrompt(pendingElicitation.input),
        expires_at: pendingElicitation.expires_at,
      }
    : null;

  const nextAction = computeNextAction({
    activeKind,
    connector,
    connectorSaved,
    hasWorkflow,
    workflowSaved,
    workflowOpen,
    focusedRun: focusedRun !== null,
    probe,
    preview,
    pendingApproval,
  });

  const stage = computeStage({
    activeKind,
    connectorSaved,
    hasWorkflow,
    workflowSaved,
    workflowOpen,
    focusedRun: focusedRun !== null,
    probe,
    preview,
    pendingApproval,
  });

  const oneSentence = buildOneSentence({
    activeKind,
    targetName,
    environment,
    stage,
    pendingApproval,
    nextAction,
  });

  return {
    active_target: {
      kind: activeKind,
      name: targetName,
      slug: targetSlug,
      id: targetId,
      environment,
    },
    stage,
    focused_run: focusedRun,
    last_successful_probe: lastProbe,
    last_successful_preview: lastPreview,
    unsaved:
      activeKind === "connector" ? !connectorSaved : hasWorkflow && !workflowSaved && !workflowOpen,
    pending_approval: pendingApproval,
    next_action: nextAction,
    one_sentence: oneSentence,
  };
}

interface NextActionInputs {
  activeKind: "connector" | "workflow" | "none";
  connector: NonNullable<DraftDocument["connector"]> | null;
  connectorSaved: boolean;
  hasWorkflow: boolean;
  workflowSaved: boolean;
  workflowOpen: boolean;
  focusedRun: boolean;
  probe: ConnectorProbe | null;
  preview: WorkflowDraftPreviewSummary | null;
  pendingApproval: ResumeSummary["pending_approval"];
}

function computeNextAction(p: NextActionInputs): string {
  if (p.pendingApproval) {
    return "Resolve the pending approval to continue (approve or reject).";
  }
  if (p.activeKind === "connector" && !p.connectorSaved) {
    if (p.probe?.ok !== true) {
      return "Probe the connector draft before saving so auth and response shape are verified.";
    }
    return "Save the connector draft now that the probe succeeded.";
  }
  if (p.activeKind === "workflow" || (p.connectorSaved && p.hasWorkflow)) {
    if (p.workflowSaved)
      return "Workflow saved. Review activation and automatic-run permission in the workflow.";
    if (p.focusedRun) return "Ask what went wrong in this run, or how to repair it.";
    if (p.workflowOpen) return "Describe what to change in this workflow.";
    if (p.preview?.ok !== true) {
      return "Preview a step or the whole workflow before committing.";
    }
    return "Commit the workflow — the last preview succeeded.";
  }
  if (p.connectorSaved && !p.hasWorkflow) {
    return "Describe the workflow you want to build with this saved connector.";
  }
  return "Continue the conversation.";
}

function computeStage(
  p: Pick<
    NextActionInputs,
    | "activeKind"
    | "connectorSaved"
    | "hasWorkflow"
    | "workflowSaved"
    | "workflowOpen"
    | "focusedRun"
    | "probe"
    | "preview"
    | "pendingApproval"
  >,
): string {
  if (p.pendingApproval) return "awaiting_approval";
  if (p.activeKind === "connector" && !p.connectorSaved) {
    if (p.probe?.ok === true) return "connector_ready_to_save";
    return "connector_drafting";
  }
  if (p.activeKind === "workflow" || (p.connectorSaved && p.hasWorkflow)) {
    if (p.workflowSaved) return "workflow_saved";
    if (p.focusedRun) return "run_focus";
    if (p.workflowOpen) return "workflow_open";
    if (p.preview?.ok === true) return "workflow_ready_to_commit";
    return "workflow_drafting";
  }
  if (p.connectorSaved) return "connector_saved";
  return "onboarding";
}

interface OneSentenceInputs {
  activeKind: "connector" | "workflow" | "none";
  targetName: string | null;
  environment: string | null;
  stage: string;
  pendingApproval: ResumeSummary["pending_approval"];
  nextAction: string;
}

function buildOneSentence(p: OneSentenceInputs): string {
  const target =
    p.activeKind === "connector"
      ? `connector${p.targetName ? ` "${p.targetName}"` : ""}`
      : p.activeKind === "workflow"
        ? `workflow${p.targetName ? ` "${p.targetName}"` : ""}`
        : "this conversation";
  const env = p.environment ? ` in ${p.environment}` : "";
  if (p.pendingApproval) {
    return `You were setting up ${target}${env} and left an approval pending. ${p.nextAction}`;
  }
  switch (p.stage) {
    case "connector_ready_to_save":
      return `You were setting up ${target}${env}; the probe succeeded. ${p.nextAction}`;
    case "connector_drafting":
      return `You were drafting ${target}${env} but have not probed it yet. ${p.nextAction}`;
    case "workflow_saved":
      return `You saved ${target}. ${p.nextAction}`;
    case "run_focus":
      return `You are looking into a run of ${target}. ${p.nextAction}`;
    case "workflow_open":
      return `You are working on ${target}. ${p.nextAction}`;
    case "workflow_ready_to_commit":
      return `You were authoring ${target}; the last preview succeeded. ${p.nextAction}`;
    case "workflow_drafting":
      return `You were authoring ${target} but have not previewed it yet. ${p.nextAction}`;
    case "connector_saved":
      return `You saved a connector but have not started a workflow yet. ${p.nextAction}`;
    default:
      return `You have an in-progress conversation. ${p.nextAction}`;
  }
}

export interface ExternalToolSubject {
  connector: string;
  tool: string;
  server_claim?: string;
}

export interface ConnectorCallSubject {
  connector: string;
  method: string;
  target: string | null;
}

function connectorCallSubject(value: unknown): ConnectorCallSubject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { connector, method, target } = value as Record<string, unknown>;
  if (typeof connector !== "string" || !connector.trim()) return undefined;
  if (typeof method !== "string" || !method.trim()) return undefined;
  return { connector, method, target: typeof target === "string" && target ? target : null };
}

function externalToolSubject(value: unknown): ExternalToolSubject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { connector, tool, server_claim } = value as Record<string, unknown>;
  if (typeof connector !== "string" || !connector.trim()) return undefined;
  if (typeof tool !== "string" || !tool.trim()) return undefined;
  return {
    connector,
    tool,
    ...(typeof server_claim === "string" && server_claim.trim() ? { server_claim } : {}),
  };
}

export function pendingPrompt(input: unknown): {
  prompt?: {
    question: string;
    intent_kind?: string;
    authorization_url?: string;
    fields?: ResumeFormField[];
    external_tool?: ExternalToolSubject;
    effect?: ConnectorCallSubject;
  };
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  if (typeof value.question !== "string" || !value.question.trim()) return {};
  const fields = resumeFormFields(value.fields);
  const externalTool = externalToolSubject(value.external_tool);
  const effect = connectorCallSubject(value.effect);
  const intent = value.commit_intent as { kind?: unknown } | undefined;
  let authorizationUrl: string | undefined;
  if (intent?.kind === "oauth_completed" && typeof value.authorization_url === "string") {
    try {
      const url = new URL(value.authorization_url);
      if (
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) &&
        !url.username &&
        !url.password
      )
        authorizationUrl = value.authorization_url;
    } catch {}
  }
  return {
    prompt: {
      question: value.question,
      ...(fields ? { fields } : {}),
      ...(typeof intent?.kind === "string" ? { intent_kind: intent.kind } : {}),
      ...(authorizationUrl ? { authorization_url: authorizationUrl } : {}),
      ...(externalTool ? { external_tool: externalTool } : {}),
      ...(effect ? { effect } : {}),
    },
  };
}
