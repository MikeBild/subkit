import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function createRefusal(
  failure: unknown,
  taken: string,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  if (failure instanceof ApiError && failure.status === 409) return taken;
  if (failure instanceof ApiError && failure.message)
    return t("stepEditor.refused", { reason: failure.message });
  return t("common.actionFailed");
}
