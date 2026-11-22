import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export function createSourceFailureKey(error: unknown): TranslationKey {
  const status = statusOf(error);
  if (status === 422) return "kn.sources.unreadable";
  if (status === 413) return "kn.up.tooBig";
  return "common.actionFailed";
}

export function saveTextFailureKey(error: unknown): TranslationKey {
  return statusOf(error) === 409 ? "kn.conflict" : "common.actionFailed";
}
