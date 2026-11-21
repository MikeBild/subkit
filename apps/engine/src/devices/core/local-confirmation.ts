export const LOCAL_CONFIRMATION_WINDOW_MS = 15 * 60_000;

export const NOTHING_CHANGED = {
  de: "Es wurde nichts gesendet oder geändert.",
  en: "Nothing was sent or changed.",
} as const;

export const LOCAL_CONFIRMATION_STATES = ["requested", "granted", "declined", "expired"] as const;
export type LocalConfirmationState = (typeof LOCAL_CONFIRMATION_STATES)[number];

export type LocalConfirmationEvent = "grant" | "decline" | "expire";

export type LocalConfirmationRefusal = "already_decided" | "expired" | "not_due";

export type LocalConfirmationStep =
  | { readonly ok: true; readonly state: Exclude<LocalConfirmationState, "requested"> }
  | { readonly ok: false; readonly refusal: LocalConfirmationRefusal };

export type ToolCallConfirmationState = "proposed" | "confirmed" | "declined" | "expired";

const TOOL_CALL_STATE: Readonly<Record<LocalConfirmationState, ToolCallConfirmationState>> = {
  requested: "proposed",
  granted: "confirmed",
  declined: "declined",
  expired: "expired",
};

export function toolCallStateOf(state: LocalConfirmationState): ToolCallConfirmationState {
  return TOOL_CALL_STATE[state];
}

export function localConfirmationDeadline(
  requested_at: Date,
  limits: readonly (Date | null)[],
): Date {
  const ends = limits.flatMap((limit) => (limit === null ? [] : [limit.getTime()]));
  return new Date(Math.min(requested_at.getTime() + LOCAL_CONFIRMATION_WINDOW_MS, ...ends));
}

export function localConfirmationStep(
  state: LocalConfirmationState,
  event: LocalConfirmationEvent,
  deadline: Date,
  now: Date,
): LocalConfirmationStep {
  if (state !== "requested") {
    return { ok: false, refusal: state === "expired" ? "expired" : "already_decided" };
  }
  const due = now.getTime() >= deadline.getTime();
  if (event === "expire")
    return due ? { ok: true, state: "expired" } : { ok: false, refusal: "not_due" };
  if (due) return { ok: false, refusal: "expired" };
  return { ok: true, state: event === "grant" ? "granted" : "declined" };
}

export type ConfirmerRefusal =
  | "device_runner"
  | "no_person"
  | "no_browser_session"
  | "not_owner"
  | "missing_permission";

export interface ConfirmerFacts {
  readonly principal_kind: "user" | "system_account" | null;
  readonly auth_source: string | null;
  readonly delegated: boolean;
  readonly actor_id: string | null;
  readonly owner_id: string | null;
  readonly holds_local_confirm: boolean;
}

export function confirmerRefusal(facts: ConfirmerFacts): ConfirmerRefusal | null {
  if (facts.auth_source === "device_runner") return "device_runner";
  if (facts.principal_kind !== "user" || facts.actor_id === null) return "no_person";
  if (facts.auth_source !== "browser_session" || facts.delegated) return "no_browser_session";
  if (facts.actor_id !== facts.owner_id) return "not_owner";
  if (!facts.holds_local_confirm) return "missing_permission";
  return null;
}

export function grantsConfirmation(
  status: "resolved" | "cancelled" | "timeout",
  decision: "confirmed" | "declined" | "ambiguous",
): boolean {
  return status === "resolved" && decision === "confirmed";
}
