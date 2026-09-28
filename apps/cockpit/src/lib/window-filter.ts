import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * The words on the chip a time window arrived with — from the usage page's
 * figures, which count over a window and link into the run log and the audit
 * trail narrowed to the same one. Said out loud and removable, like every
 * narrowing a link brings: a list shorter than its page usually is, with no
 * reason on screen, reads as missing data.
 */
export function windowFilterLabel(
  from: string | null,
  to: string | null,
  t: Translate,
  dateTime: (value: string) => string,
): string {
  if (from && to) return t("filter.window.between", { from: dateTime(from), to: dateTime(to) });
  if (from) return t("filter.window.since", { from: dateTime(from) });
  return t("filter.window.until", { to: dateTime(to ?? "") });
}
