import { createContext, useContext } from "react";

import type { TranslationKey } from "./i18n";
import type { LocalePreference, LocaleSnapshot } from "./locale-store";

export interface I18nValue extends LocaleSnapshot {
  setPreference(preference: LocalePreference): void;
  t(key: TranslationKey, values?: Record<string, string | number>): string;
  dateTime(value: string | Date): string;
}

export const I18nContext = createContext<I18nValue | null>(null);

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n requires I18nProvider");
  return value;
}

export type { LocalePreference };
