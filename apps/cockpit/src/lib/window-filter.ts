import type { Translate } from "@/lib/i18n";

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
