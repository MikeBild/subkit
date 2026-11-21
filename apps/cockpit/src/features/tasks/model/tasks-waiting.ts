import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

type Run = components["schemas"]["TaskRun"];

export type WaitingReason = NonNullable<Run["waiting_reason"]>;
export type WaitingParty = "you" | "budget" | "ai_access";
export type WaitingAction = "answer" | "continue" | "usage" | "ai_access";

export interface WaitingView {
  party: WaitingParty;
  line: TranslationKey;
  action: WaitingAction;
}

const WAITING: Record<WaitingReason, WaitingView> = {
  question: { party: "you", line: "tasks.strip.waiting.question", action: "answer" },
  approval: { party: "you", line: "tasks.strip.waiting.approval", action: "answer" },
  question_expired: {
    party: "you",
    line: "tasks.strip.waiting.question_expired",
    action: "answer",
  },
  no_progress: { party: "you", line: "tasks.strip.waiting.no_progress", action: "continue" },
  turn_stopped: { party: "you", line: "tasks.strip.waiting.turn_stopped", action: "continue" },
  budget: { party: "budget", line: "tasks.strip.waiting.budget", action: "usage" },
  ai_access: { party: "ai_access", line: "tasks.strip.waiting.ai_access", action: "ai_access" },
};

export const WAITING_REASONS = Object.keys(WAITING) as WaitingReason[];

export function waitingView(reason: string | null | undefined): WaitingView {
  return reason && Object.hasOwn(WAITING, reason)
    ? WAITING[reason as WaitingReason]
    : WAITING.question;
}

const LIMIT_LINES = {
  turn_limit_reached: "tasks.strip.limit.turns",
  deadline_exceeded: "tasks.strip.limit.deadline",
} as const satisfies Partial<Record<NonNullable<Run["failure_code"]>, TranslationKey>>;

export type RunLimitCode = keyof typeof LIMIT_LINES;

export const RUN_LIMIT_CODES = Object.keys(LIMIT_LINES) as RunLimitCode[];

export function limitEndedLine(
  run: { state: string; failure_code?: string | null } | null | undefined,
): TranslationKey | null {
  const code = run?.state === "failed" ? run.failure_code : null;
  return code && Object.hasOwn(LIMIT_LINES, code) ? LIMIT_LINES[code as RunLimitCode] : null;
}

type Glance = { state: string; waiting_reason?: string | null };

export function waitingParty(run: Glance | null | undefined): WaitingParty | null {
  if (run?.state === "result_ready") return "you";
  return run?.state === "waiting" ? waitingView(run.waiting_reason).party : null;
}

export function waitsForPerson(run: Glance | null | undefined): boolean {
  return waitingParty(run) === "you";
}

const PARTY_KEYS: Record<WaitingParty, TranslationKey> = {
  you: "tasks.overview.waiting.you",
  budget: "tasks.overview.waiting.budget",
  ai_access: "tasks.overview.waiting.aiAccess",
};

export function waitingForKey(run: Glance | null | undefined): TranslationKey | null {
  const party = waitingParty(run);
  return party ? PARTY_KEYS[party] : null;
}

const STATE_KEYS: Record<Exclude<WaitingParty, "you">, TranslationKey> = {
  budget: "tasks.state.waitingBudget",
  ai_access: "tasks.state.waitingAiAccess",
};

export function waitingStateKey(run: Glance | null | undefined): TranslationKey | null {
  const party = run?.state === "waiting" ? waitingParty(run) : null;
  return party && party !== "you" ? STATE_KEYS[party] : null;
}

const REASON_KEYS: Record<WaitingReason, TranslationKey> = {
  question: "tasks.reason.question",
  approval: "tasks.reason.approval",
  question_expired: "tasks.reason.question_expired",
  no_progress: "tasks.reason.no_progress",
  turn_stopped: "tasks.reason.turn_stopped",
  budget: "tasks.reason.budget",
  ai_access: "tasks.reason.ai_access",
};

export function waitingReasonKey(reason: unknown): TranslationKey | null {
  return typeof reason === "string" && Object.hasOwn(REASON_KEYS, reason)
    ? REASON_KEYS[reason as WaitingReason]
    : null;
}
