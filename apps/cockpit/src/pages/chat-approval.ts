import type { ConversationDetail } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";
import { toolOutcomeKey } from "@/lib/tool-presentation";

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
  authorizationUrl?: string;
  externalTool?: { connector: string; tool: string; server_claim?: string };
  connectorCall?: { connector: string; method: string; target: string | null };
  gatedTool?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function chatApproval(detail: ConversationDetail | undefined): ChatApproval | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (pending?.tool_name !== "ask_user_confirm" || !pending.tool_call_id) return null;
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
    savesInactiveWorkflow: intent.kind === "save_workflow_draft",
    expiresAt: pending.expires_at,
    ...(intent.kind === "commit_held_workflow_writes" || intent.kind === "run_workflow"
      ? { singleRun: true, workflowName: detail?.resume_summary?.active_target?.name ?? undefined }
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

export type ApprovalSubject = Pick<
  ChatApproval,
  | "question"
  | "oauth"
  | "singleRun"
  | "workflowName"
  | "savesInactiveWorkflow"
  | "externalTool"
  | "connectorCall"
  | "gatedTool"
>;

type Translate = (key: TranslationKey, values?: Record<string, string>) => string;

export function approvalLine(
  subject: ApprovalSubject,
  t: Translate,
  readable: (value: string) => string,
): string {
  if (subject.oauth)
    return t(subject.oauth === "start" ? "chat.oauth.startHelp" : "chat.oauth.completeHelp");
  if (subject.singleRun)
    return t("chat.singleRun.effect", {
      name: subject.workflowName ?? t("chat.singleRun.thisWorkflow"),
    });
  if (subject.savesInactiveWorkflow) return t("chat.decision.saveEffect");
  if (subject.externalTool)
    return t("chat.decision.externalTool", {
      connector: subject.externalTool.connector,
      tool: subject.externalTool.tool,
    });
  if (subject.connectorCall)
    return readable(
      subject.connectorCall.target
        ? t("chat.decision.connectorCall", {
            connector: subject.connectorCall.connector,
            method: subject.connectorCall.method,
            target: subject.connectorCall.target,
          })
        : t("chat.decision.connectorCallBare", {
            connector: subject.connectorCall.connector,
            method: subject.connectorCall.method,
          }),
    );
  if (subject.gatedTool) return t("chat.decision.gatedAction");
  return readable(subject.question);
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
  return {
    question: pending.prompt?.question ?? pending.summary,
    ...(externalTool ? { externalTool } : {}),
    ...(connectorCall ? { connectorCall } : {}),
    ...(!externalTool && !connectorCall && intent === "execute_confirmed_tool_call"
      ? { gatedTool: pending.tool_name }
      : {}),
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
  return detail?.resume_summary?.pending_approval ? OPEN_QUESTION_REFRESH_MS : false;
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
