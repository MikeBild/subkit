import { type PluralKey, pluralKey, type TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function plural(
  t: Translate,
  key: PluralKey,
  n: number,
  values: Record<string, string | number> = {},
): string {
  return t(pluralKey(key, n), { n, ...values });
}
