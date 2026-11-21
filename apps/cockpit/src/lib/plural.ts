import type { Translate } from "@/lib/i18n";
import { type PluralKey, pluralKey } from "@/lib/i18n";

export function plural(
  t: Translate,
  key: PluralKey,
  n: number,
  values: Record<string, string | number> = {},
): string {
  return t(pluralKey(key, n), { n, ...values });
}
