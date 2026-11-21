import { errorCatalog } from "@shared/error-catalog.ts";
import { UiProvider } from "@ui/lib/ui-context";
import { Workflow } from "lucide-react";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { ActionFailureHost } from "@/components/cockpit/patterns/action-failure";
import { formatDateTime, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { createLocaleStore } from "@/lib/locale-store";
import { LOCALE_COOKIE, sharePreference } from "@/lib/preference-cookie";

const DIALOG_NOTICE = <ActionFailureHost className="mt-2" />;

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
  share: (locale) => sharePreference(LOCALE_COOKIE, locale),
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
  return (
    <I18nContext.Provider value={value}>
      <UiProvider
        lang={snapshot.locale === "en" ? "en" : "de"}
        fmt={value.dateTime}
        mark={Workflow}
        appName="SubKit"
        dialogNotice={DIALOG_NOTICE}
        errors={errorCatalog(snapshot.locale === "en" ? "en" : "de")}
      >
        {children}
      </UiProvider>
    </I18nContext.Provider>
  );
}
