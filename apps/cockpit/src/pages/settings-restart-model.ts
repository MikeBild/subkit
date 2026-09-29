// What the settings page offers when a saved setting waits for a restart, and
// how it reads the engine while that restart runs. Pure, so the three offers
// and the polling verdicts are tested without a browser.

import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

/** `GET /v1/system/restart-status`. */
export interface RestartStatus {
  boot_id: string;
  started_at: string;
  saved_revision: number;
  active_revision: number;
  activation_status: string;
  restart_supervised: boolean;
  pending_restart_fields: string[];
}

/** `POST /v1/system/restart` → 202. */
export interface RestartAccepted {
  request_id: string;
  audit_id: string;
  boot_id: string;
  expected_revision: number;
}

export const RESTART_STATUS_PATH = "/v1/system/restart-status";
export const RESTART_PATH = "/v1/system/restart";
/** After this long without the new process, the page stops saying "restarting". */
export const RESTART_CONFIRM_TIMEOUT_MS = 240_000;
export const RESTART_POLL_MS = 2_000;

/**
 * - `restart`: the reader may restart and a supervisor brings SubKit back.
 * - `manual`: the reader may restart, but no supervisor is declared (or the
 *   status could not be read) — the page says how to restart by hand.
 * - `ask_admin`: the reader may not restart.
 */
export type RestartOffer = "restart" | "manual" | "ask_admin";

export function restartOffer(
  permissions: readonly string[],
  supervised: boolean | null | undefined,
): RestartOffer {
  if (!permissions.includes("system:restart")) return "ask_admin";
  return supervised === true ? "restart" : "manual";
}

/** The line the save-time restart dialog ends with, per offer. */
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

/** A restarting engine answers with no connection at all, or with a gateway or
 * draining status; any other answer is a real one. */
export function isStillRestarting(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  // fetch rejects with a TypeError when nothing answers.
  return error instanceof TypeError;
}

export type RestartVerdict = "waiting" | "restarted" | "not_activated";

/** One poll answer, judged: the same process is still draining; a new process
 * runs the saved revision; or a new process runs without it. */
export function restartVerdict(fromBootId: string, status: RestartStatus | null): RestartVerdict {
  if (!status || status.boot_id === fromBootId) return "waiting";
  return status.active_revision === status.saved_revision ? "restarted" : "not_activated";
}

/** The wording for a refused request, by the engine's code. */
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
    default:
      return "common.actionFailed";
  }
}

/** A new session secret signs every session out; the restart has to say so. */
export function restartSignsEveryoneOut(pendingFields: readonly string[]): boolean {
  return pendingFields.includes("auth.session.secret");
}
