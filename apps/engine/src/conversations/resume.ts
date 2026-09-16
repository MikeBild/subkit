// Resume summary for conversations.
//
// Surfaces a single-sentence "where were we / what next" banner whenever
// someone reattaches to an existing conversation (either via /resume or by
// fetching the detail endpoint while the conversation is neither active
// nor a single-turn session). Purely a projection over the persisted
// conversation row + draft — no side effects, no model calls.

import { refreshDraftSummary } from "./authoring-state.ts";
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
  last_successful_probe: string | null;
  last_successful_preview: string | null;
  unsaved: boolean;
  pending_approval: {
    id: string;
    tool_call_id?: string | null;
    tool_name: string;
    prompt?: { question: string; intent_kind?: string; authorization_url?: string };
    summary: string;
    /** When this approval lapses. The only real deadline in the product;
     *  without it a client cannot tell "running out" from "just waiting". */
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
    /** ISO instant the prompt lapses. Carried through so the resume banner —
     *  and the decision queue reading it — can say how long is left. */
    expires_at: string;
  } | null;
}

/**
 * True when re-attaching this conversation is genuinely a "resume" — i.e.
 * there is prior work to carry forward. A brand-new, one-turn, or already
 * committed conversation does not need a resume banner.
 */
export function shouldShowResumeSummary(params: BuildResumeSummaryParams): boolean {
  const { conversation, draft } = params;
  if (conversation.status === "committed" || conversation.status === "abandoned") return false;
  // A pending question is actionable even before any draft exists.
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
  const workflowSaved =
    d.summary?.checkpoints.some(
      (checkpoint) =>
        checkpoint.key === "workflow_persisted" &&
        checkpoint.status === "fresh" &&
        checkpoint.ok === true,
    ) ?? false;
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
    probe,
    preview,
    pendingApproval,
  });

  const stage = computeStage({
    activeKind,
    connectorSaved,
    hasWorkflow,
    workflowSaved,
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
    last_successful_probe: lastProbe,
    last_successful_preview: lastPreview,
    unsaved: activeKind === "connector" ? !connectorSaved : hasWorkflow && !workflowSaved,
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

/** Project the dialog fields only; never expose its execution or approval capability. */
export function pendingPrompt(input: unknown): {
  prompt?: { question: string; intent_kind?: string; authorization_url?: string };
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  if (typeof value.question !== "string" || !value.question.trim()) return {};
  const intent = value.commit_intent as { kind?: unknown } | undefined;
  let authorizationUrl: string | undefined;
  if (intent?.kind === "oauth_completed" && typeof value.authorization_url === "string") {
    try {
      const url = new URL(value.authorization_url);
      if (url.protocol === "https:" && !url.username && !url.password)
        authorizationUrl = value.authorization_url;
    } catch {
      /* Invalid destinations are never clickable. */
    }
  }
  return {
    prompt: {
      question: value.question,
      ...(typeof intent?.kind === "string" ? { intent_kind: intent.kind } : {}),
      ...(authorizationUrl ? { authorization_url: authorizationUrl } : {}),
    },
  };
}
