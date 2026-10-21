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
