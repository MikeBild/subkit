import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { formatDateTime, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { createLocaleStore } from "@/lib/locale-store";

const localeStore = createLocaleStore({
  read: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
  remove: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
  languages: () => navigator.languages,
  apply: (locale) => document.documentElement.setAttribute("lang", locale),
  watch: (listener) => {
    window.addEventListener("languagechange", listener);
    window.addEventListener("storage", listener);
  },
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    localeStore.subscribe,
    localeStore.snapshot,
    localeStore.snapshot,
  );
  const value = useMemo<I18nValue>(
    () => ({
      ...snapshot,
      setPreference: localeStore.set,
      t: (key, values) => translate(snapshot.locale, key, values),
      tn: (key, count, values) => translatePlural(snapshot.locale, key, count, values),
      dateTime: (date) => formatDateTime(snapshot.locale, date),
    }),
    [snapshot],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
