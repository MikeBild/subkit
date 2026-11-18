import { nameFromEmail } from "@/lib/display-name";
import type { TranslationKey } from "@/lib/i18n";
import { AI_ACCESS_REFUSAL_KEY, aiAccessRefusal, type OwnKeyProvider } from "@/pages/ai-providers";

export const NAME_MAX = 120;
export const KEY_MAX = 4096;

export interface WelcomeValues {
  name: string;
  workspace: string;
  timezone: string;
  provider: OwnKeyProvider;
  key: string;
}

export function suggestedName(pending: {
  email: string;
  suggested_display_name: string | null;
}): string {
  return (pending.suggested_display_name?.trim() || nameFromEmail(pending.email)).slice(
    0,
    NAME_MAX,
  );
}

export function workspaceSuggestion(name: string, template: (name: string) => string): string {
  const trimmed = name.trim();
  return trimmed ? template(trimmed).slice(0, NAME_MAX) : "";
}

type WelcomeField = "name" | "workspace" | "timezone" | "key";

export function welcomeErrors(
  values: WelcomeValues,
): Partial<Record<WelcomeField, TranslationKey>> {
  return {
    ...(values.name.trim() ? {} : { name: "welcome.nameError" as const }),
    ...(values.workspace.trim() ? {} : { workspace: "welcome.workspaceError" as const }),
    ...(values.timezone ? {} : { timezone: "welcome.timezoneError" as const }),
    ...(values.key.trim() ? {} : { key: "welcome.ai.keyError" as const }),
  };
}

export function welcomeRequest(values: WelcomeValues) {
  return {
    display_name: values.name.trim(),
    workspace_name: values.workspace.trim(),
    timezone: values.timezone,
    llm_provider: values.provider,
    llm_api_key: values.key.trim(),
  };
}

export function keyAfterSubmit(key: string, outcome: "created" | "refused"): string {
  return outcome === "created" ? "" : key;
}

export type WelcomeFailure =
  | "expired"
  | "unavailable"
  | "timezone"
  | "stale"
  | "keyRejected"
  | "providerUnreachable"
  | "providerUnavailable"
  | "tooManyAttempts"
  | "notStored"
  | "generic";

const UNAVAILABLE_CODES = new Set([
  "registration_closed",
  "registration_rate_limited",
  "registration_policy_unavailable",
]);

export function welcomeFailure(error: { status: number; code: string | null }): WelcomeFailure {
  if (error.status === 401) return "expired";
  if (error.code === "invalid_timezone") return "timezone";
  if (error.code === "registration_csrf_rejected") return "stale";
  if (error.code === "llm_probe_rate_limited") return "tooManyAttempts";
  if (error.code === "llm_access_not_stored") return "notStored";
  const refusal = aiAccessRefusal(error.code);
  if (refusal === "keyRejected") return "keyRejected";
  if (refusal === "unreachable") return "providerUnreachable";
  if (refusal) return "providerUnavailable";
  if (error.status === 429 || error.status === 503 || UNAVAILABLE_CODES.has(error.code ?? ""))
    return "unavailable";
  return "generic";
}

export type WelcomeFailurePlace = "key" | "timezone" | "alert";

export function welcomeFailurePlace(failure: WelcomeFailure): WelcomeFailurePlace {
  if (failure === "keyRejected") return "key";
  if (failure === "timezone") return "timezone";
  return "alert";
}

export function welcomeFailureKey(failure: WelcomeFailure): TranslationKey {
  if (failure === "unavailable") return "welcome.unavailable";
  if (failure === "timezone") return "welcome.timezoneError";
  if (failure === "keyRejected") return AI_ACCESS_REFUSAL_KEY.keyRejected;
  if (failure === "providerUnreachable") return AI_ACCESS_REFUSAL_KEY.unreachable;
  if (failure === "providerUnavailable") return AI_ACCESS_REFUSAL_KEY.providerUnavailable;
  if (failure === "tooManyAttempts") return "welcome.ai.tooMany";
  if (failure === "notStored") return "welcome.ai.notStored";
  return "standalone.error";
}
