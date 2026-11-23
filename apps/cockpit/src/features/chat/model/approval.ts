import type { ConversationDetail } from "@/api/client";
import type { Translate, TranslationKey } from "@/lib/i18n";
import { toolOutcomeKey } from "@/lib/tool-presentation";
import type { DeviceConfirmation } from "./device-approval";
import { type ApprovalBinding, approvalBinding, namedAccount } from "./policy";
import { type TaskWriteAction, taskActionLine, taskActionOf } from "./task-approval";
import { runMarker } from "./task-run";

export interface ChatApproval {
  id: string;
  toolCallId: string;
  question: string;
  description: string | null;
  savesInactiveWorkflow: boolean;
  expiresAt: string;
  oauth?: "start" | "complete";
  singleRun?: boolean;
  workflowName?: string;
  workflowSlug?: string;
  authorizationUrl?: string;
  externalTool?: { connector: string; tool: string; server_claim?: string };
  connectorCall?: { connector: string; method: string; target: string | null };
  gatedTool?: string;
  taskAction?: TaskWriteAction;
  subjects?: string[];
  transferBytes?: number;
  decidedByOthers?: boolean;
  binding?: ApprovalBinding;
  device?: DeviceConfirmation;
  changes?: { label: string; preview?: string }[];
}

export interface ChatApprovalOptions {
  output?: { confirmed: boolean; partial?: boolean; approved_indices?: number[] };
  followUp?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function withWorkflowName(
  approval: ChatApproval,
  nameFor: (slug: string) => string | null,
): ChatApproval {
  const name = approval.workflowSlug ? nameFor(approval.workflowSlug) : null;
  return name ? { ...approval, workflowName: name } : approval;
}

export function chatApproval(
  detail: ConversationDetail | undefined,
  viewerId?: string | null,
  viewerIsAdmin = false,
): ChatApproval | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (pending?.tool_name !== "ask_user_confirm" || !pending.tool_call_id) return null;
  const prompted = pending.prompt?.device;
  const device: DeviceConfirmation | null = prompted
    ? {
        device_id: prompted.device_id,
        capability: prompted.capability,
        target: prompted.target,
        deadline_at: prompted.deadline_at,
      }
    : null;
  const call = detail?.tool_calls.find((candidate) => candidate.id === pending.tool_call_id);
  if (!call) return null;
  if (call.tool !== "ask_user_confirm" && !pending.prompt) return null;
  const input = pending.prompt
    ? { ...pending.prompt, commit_intent: { kind: pending.prompt.intent_kind } }
    : record(call.input);
  const intent = record(input.commit_intent);
  if (typeof input.question !== "string" || !input.question.trim()) return null;
  const externalTool =
    intent.kind === "grant_relayed_tool_call" ? pending.prompt?.external_tool : undefined;
  const connectorCall = externalTool ? undefined : pending.prompt?.effect;
  const gatedTool =
    !externalTool && !connectorCall && intent.kind === "execute_confirmed_tool_call"
      ? call.tool
      : undefined;
  const taskAction = taskActionOf(gatedTool, call.input);
  const bound = approvalBinding(call);
  const binding = bound
    ? { ...bound, action: namedAccount(bound.action, () => connectorCall?.connector) }
    : null;
  const decidedByOthers =
    pending.prompt?.approval_backed === true &&
    viewerId !== undefined &&
    !viewerIsAdmin &&
    runMarker(detail?.draft) !== null &&
    detail?.conversation.owner_id !== viewerId;
  return {
    id: pending.id,
    toolCallId: call.id,
    question: input.question,
    description:
      !externalTool && !connectorCall && !gatedTool && typeof intent.description === "string"
        ? intent.description
        : null,
    ...(externalTool ? { externalTool } : {}),
    ...(connectorCall ? { connectorCall } : {}),
    ...(gatedTool ? { gatedTool } : {}),
    ...(taskAction ? { taskAction } : {}),
    ...(decidedByOthers ? { decidedByOthers } : {}),
    ...(binding ? { binding } : {}),
    ...(device ? { device } : {}),
    ...(pending.prompt?.kind === "partial_diff_approval" && pending.prompt.diffs?.length
      ? { changes: pending.prompt.diffs }
      : {}),
    ...(pending.prompt?.subjects?.length ? { subjects: pending.prompt.subjects } : {}),
    ...(pending.prompt?.transfer_bytes ? { transferBytes: pending.prompt.transfer_bytes } : {}),
    savesInactiveWorkflow: intent.kind === "save_workflow_draft",
    expiresAt: device?.deadline_at ?? pending.expires_at,
    ...(intent.kind === "commit_held_workflow_writes" || intent.kind === "run_workflow"
      ? {
          singleRun: true,
          workflowName: detail?.resume_summary?.active_target?.name ?? undefined,
          ...(typeof record(call.input).workflow === "string"
            ? { workflowSlug: record(call.input).workflow as string }
            : {}),
        }
      : {}),
    ...(call.tool === "authenticate_oauth"
      ? {
          oauth: (pending.prompt?.intent_kind === "oauth_completed" ? "complete" : "start") as
            | "complete"
            | "start",
        }
      : {}),
    ...(pending.prompt?.authorization_url
      ? { authorizationUrl: pending.prompt.authorization_url }
      : {}),
  };
}

type ApprovalSubject = Pick<
  ChatApproval,
  | "question"
  | "oauth"
  | "singleRun"
  | "workflowName"
  | "savesInactiveWorkflow"
  | "externalTool"
  | "connectorCall"
  | "gatedTool"
  | "taskAction"
>;

type Mark = (value: string) => string;

const same: Mark = (value) => value;

function approvalSentence(
  subject: ApprovalSubject,
  t: Translate,
  readable: (value: string) => string,
  mark: Mark,
): string {
  if (subject.oauth)
    return t(subject.oauth === "start" ? "chat.oauth.startHelp" : "chat.oauth.completeHelp");
  if (subject.singleRun)
    return t("chat.singleRun.effect", {
      name: subject.workflowName ? mark(subject.workflowName) : t("chat.singleRun.thisWorkflow"),
    });
  if (subject.savesInactiveWorkflow) return t("chat.decision.saveEffect");
  if (subject.externalTool)
    return t("chat.decision.externalTool", {
      connector: mark(subject.externalTool.connector),
      tool: mark(subject.externalTool.tool),
    });
  if (subject.connectorCall) {
    const connector = mark(readable(subject.connectorCall.connector));
    const method = readable(subject.connectorCall.method);
    return subject.connectorCall.target
      ? t("chat.decision.connectorCall", {
          connector,
          method,
          target: mark(readable(subject.connectorCall.target)),
        })
      : t("chat.decision.connectorCallBare", { connector, method });
  }
  const taskLine = subject.taskAction ? taskActionLine(subject.taskAction, t, mark) : null;
  if (taskLine) return taskLine;
  if (subject.gatedTool) return t("chat.decision.gatedAction");
  return readable(subject.question);
}

export function approvalLine(
  subject: ApprovalSubject,
  t: Translate,
  readable: (value: string) => string,
): string {
  return approvalSentence(subject, t, readable, same);
}

export interface LinePart {
  id: string;
  text: string;
  strong: boolean;
}

const SLOT = "\u0000";

export function markedParts(build: (mark: Mark) => string): LinePart[] {
  const values: string[] = [];
  const sentence = build((value) => {
    values.push(value.replaceAll(SLOT, ""));
    return `${SLOT}${values.length - 1}${SLOT}`;
  });
  if (values.length === 0) return sentence ? [{ id: "t0", text: sentence, strong: false }] : [];
  return sentence.split(SLOT).flatMap((piece, index): LinePart[] => {
    if (index % 2 === 0) return piece ? [{ id: `t${index}`, text: piece, strong: false }] : [];
    const value = values[Number(piece)];
    return value ? [{ id: `s${index}`, text: value, strong: true }] : [];
  });
}

export function approvalLineParts(
  subject: ApprovalSubject,
  t: Translate,
  readable: (value: string) => string,
): LinePart[] {
  return markedParts((mark) => approvalSentence(subject, t, readable, mark));
}

type PendingApproval = NonNullable<
  NonNullable<ConversationDetail["resume_summary"]>["pending_approval"]
>;

export function pendingApprovalSubject(
  pending: PendingApproval,
  workflowName: string | null | undefined,
): ApprovalSubject {
  const intent = pending.prompt?.intent_kind;
  const externalTool =
    intent === "grant_relayed_tool_call" ? pending.prompt?.external_tool : undefined;
  const connectorCall = externalTool ? undefined : pending.prompt?.effect;
  const gated = !externalTool && !connectorCall && intent === "execute_confirmed_tool_call";
  const taskAction = gated ? taskActionOf(pending.tool_name, null) : null;
  return {
    question: pending.prompt?.question ?? pending.summary,
    ...(externalTool ? { externalTool } : {}),
    ...(connectorCall ? { connectorCall } : {}),
    ...(gated ? { gatedTool: pending.tool_name } : {}),
    ...(taskAction ? { taskAction } : {}),
    savesInactiveWorkflow: intent === "save_workflow_draft",
    ...(intent === "commit_held_workflow_writes" || intent === "run_workflow"
      ? { singleRun: true, workflowName: workflowName ?? undefined }
      : {}),
    ...(intent === "oauth_completed" ? { oauth: "complete" as const } : {}),
  };
}

export const OPEN_QUESTION_REFRESH_MS = 5_000;

export function conversationRefreshInterval(
  detail: ConversationDetail | undefined,
): number | false {
  const liveTestStatus = detail?.resume_summary?.live_test?.status;
  return detail?.resume_summary?.pending_approval ||
    liveTestStatus === "queued" ||
    liveTestStatus === "running"
    ? OPEN_QUESTION_REFRESH_MS
    : false;
}

export function recordedDecisionKey(part: unknown): TranslationKey | null {
  const decision = record(record(part).decision);
  return typeof decision.state === "string"
    ? toolOutcomeKey({ confirmationState: decision.state })
    : null;
}

export function waitsForPerson(input: {
  questions: ReadonlyArray<{ expiresAt: string } | null>;
  now: number;
  pendingApproval: unknown;
  detailLoaded: boolean;
  rowOutcome: string | null | undefined;
}): boolean {
  const asked = input.questions.filter((question) => question !== null);
  if (asked.length > 0) return asked.some((question) => Date.parse(question.expiresAt) > input.now);
  if (input.detailLoaded) return Boolean(input.pendingApproval);
  return input.rowOutcome === "awaiting_you";
}
