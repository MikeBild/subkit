import type { components } from "@cli-core/engine-api/openapi";
import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

export type RestartStatus = components["schemas"]["EngineRestartStatus"];

export type RestartAccepted = components["schemas"]["EngineRestartAccepted"];

export const RESTART_CONFIRM_TIMEOUT_MS = 240_000;
export const RESTART_POLL_MS = 2_000;

export type RestartOffer = "restart" | "manual" | "ask_admin";

export function restartOffer(
  permissions: readonly string[],
  supervised: boolean | null | undefined,
): RestartOffer {
  if (!permissions.includes("system:restart")) return "ask_admin";
  return supervised === true ? "restart" : "manual";
}

export function restartOfferAfterSave(
  offer: RestartOffer,
  supervisedDraft: string | undefined,
): RestartOffer {
  if (offer === "ask_admin" || supervisedDraft === undefined) return offer;
  if (supervisedDraft === "true") return "restart";
  if (supervisedDraft === "false") return "manual";
  return offer;
}

export function restartSaveNote(offer: RestartOffer): TranslationKey {
  switch (offer) {
    case "restart":
      return "settings.restartWho.restart";
    case "ask_admin":
      return "settings.restartWho.askAdmin";
    case "manual":
      return "settings.restartWho.manual";
  }
}

export function isStillRestarting(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}

type RestartVerdict = "waiting" | "restarted" | "not_activated";

export function restartVerdict(fromBootId: string, status: RestartStatus | null): RestartVerdict {
  if (!status || status.boot_id === fromBootId) return "waiting";
  return status.active_revision === status.saved_revision ? "restarted" : "not_activated";
}

export function restartRefusalKey(code: string | null): TranslationKey {
  switch (code) {
    case "not_supervised":
      return "settings.restartNow.manual";
    case "nothing_pending":
      return "settings.restartNow.refused.nothingPending";
    case "multiple_replicas":
      return "settings.restartNow.refused.multipleReplicas";
    case "restart_in_progress":
      return "settings.restartNow.refused.inProgress";
    case "not_ready":
      return "settings.restartNow.refused.notReady";
    default:
      return "common.actionFailed";
  }
}

export function restartSignsEveryoneOut(pendingFields: readonly string[]): boolean {
  return pendingFields.includes("auth.session.secret");
}
