import type { ConversationDetail } from "@/api/client";
import { contextualHref } from "@/app/installation-context";
import type { TranslationKey } from "@/lib/i18n";

export type ConversationPlaybook = NonNullable<ConversationDetail["playbook"]>;
export type PlaybookStep = ConversationPlaybook["steps"][number];
export type PlaybookEvidence = PlaybookStep["evidence"][number];
export type PlaybookAction = NonNullable<ConversationPlaybook["next_action"]>;

const STATUS_KEYS = {
  open: "chat.playbook.status.open",
  in_progress: "chat.playbook.status.inProgress",
  waiting_for_input: "chat.playbook.status.waiting",
  blocked: "chat.playbook.status.blocked",
  prepared: "chat.playbook.status.prepared",
  completed: "chat.playbook.status.completed",
  cancelled: "chat.playbook.status.cancelled",
} satisfies Record<ConversationPlaybook["status"], TranslationKey>;

const STEP_KEYS = {
  open: "chat.playbook.step.open",
  in_progress: "chat.playbook.step.inProgress",
  waiting_for_input: "chat.playbook.step.waiting",
  blocked: "chat.playbook.step.blocked",
  verified: "chat.playbook.step.verified",
  assessment_ready: "chat.playbook.step.assessmentReady",
  stale: "chat.playbook.step.stale",
  not_applicable: "chat.playbook.step.notApplicable",
} satisfies Record<PlaybookStep["status"], TranslationKey>;

export function playbookStatusKey(playbook: ConversationPlaybook): TranslationKey {
  return STATUS_KEYS[
    playbook.status === "completed" && playbook.completion.status !== "verified"
      ? "open"
      : playbook.status
  ];
}

export function playbookStepStatusKey(step: PlaybookStep): TranslationKey {
  return STEP_KEYS[step.status];
}

export function playbookEvidenceHref(evidence: PlaybookEvidence): string | null {
  if (evidence.freshness === "unavailable" || !evidence.href) return null;
  const href = evidence.href;
  const unsafeCharacters = (value: string) =>
    [...value].some((character) => character === "\\" || character.charCodeAt(0) <= 32);
  if (!/^\/cockpit(?:\/|\?|$)/.test(href) || unsafeCharacters(href)) return null;
  try {
    const decoded = decodeURIComponent(href);
    if (unsafeCharacters(decoded) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(decoded)) return null;
    const url = new URL(href, "https://subkit.invalid");
    if (!/^\/cockpit(?:\/|$)/.test(url.pathname)) return null;
    return contextualHref(href);
  } catch {
    return null;
  }
}

export function playbookActionTarget(
  action: PlaybookAction | null,
  questions: readonly { id: string; expiresAt: string }[],
  now: number,
): string | null {
  const id = action?.elicitation_id;
  return id &&
    questions.some((question) => question.id === id && Date.parse(question.expiresAt) > now)
    ? id
    : null;
}

type AnchorMessage = { id?: string; role: string; created_at: string };
type AnchorToolCall = {
  tool: string;
  created_at: string;
  parent_message_id?: string | null;
  outcome?: string | null;
};

function turnEnd(messages: readonly AnchorMessage[], index: number): number {
  const next = messages.findIndex((message, at) => at > index && message.role === "user");
  const bound = next < 0 ? messages.length : next;
  const lastAssistant = messages
    .slice(index, bound)
    .reduce(
      (found, message, offset) => (message.role === "assistant" ? index + offset : found),
      -1,
    );
  return lastAssistant < 0 ? index : lastAssistant;
}

function latestRevision(toolCalls: readonly AnchorToolCall[]): AnchorToolCall | null {
  return toolCalls
    .filter(
      (call) =>
        call.tool === "update_playbook" &&
        call.outcome !== "error" &&
        call.outcome !== "denied" &&
        Number.isFinite(Date.parse(call.created_at)),
    )
    .reduce<AnchorToolCall | null>(
      (found, call) =>
        !found || Date.parse(call.created_at) >= Date.parse(found.created_at) ? call : found,
      null,
    );
}

export function playbookAnchorIndex(
  messages: readonly AnchorMessage[],
  playbook: Pick<ConversationPlaybook, "updated_at">,
  toolCalls: readonly AnchorToolCall[] = [],
): number | null {
  const revision = latestRevision(toolCalls);
  const parent = revision?.parent_message_id
    ? messages.findIndex((message) => message.id === revision.parent_message_id)
    : -1;
  if (parent >= 0) return turnEnd(messages, parent);
  const anchoredAt = Date.parse(revision?.created_at ?? playbook.updated_at);
  const times = messages.map((message) => Date.parse(message.created_at));
  if (!Number.isFinite(anchoredAt) || times.some((time) => !Number.isFinite(time))) return null;
  const last = times.reduce((found, time, index) => (time <= anchoredAt ? index : found), -1);
  return last < 0 ? null : turnEnd(messages, last);
}

export function playbookSummaryVisible(contextOpen: boolean): boolean {
  return !contextOpen;
}

export function playbookPanelNextAction(playbook: ConversationPlaybook): PlaybookAction | null {
  const action = playbook.next_action;
  return action &&
    playbook.steps.some(
      (step) =>
        step.next_action?.label === action.label &&
        step.next_action.owner === action.owner &&
        step.next_action.elicitation_id === action.elicitation_id,
    )
    ? null
    : action;
}
