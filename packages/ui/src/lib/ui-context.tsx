import { de, type UiDict } from "@ui/i18n/de";
import { en } from "@ui/i18n/en";
import { type ErrorCatalog, NO_ERROR_CATALOG } from "@ui/lib/errors";
import { Box, type LucideIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export type UiLang = "de" | "en";
export const uiDicts: Record<UiLang, UiDict> = { de, en };

export interface UiEnvironment {
  lang: UiLang;
  fmt?: (iso: string) => string;
  server?: string | undefined;
  onReport?: ((text: string) => void) | undefined;
  now?: (() => number) | undefined;
  mark?: LucideIcon | undefined;
  appName?: string | undefined;
  dialogNotice?: ReactNode;
  errors?: ErrorCatalog | undefined;
}

interface UiValue extends UiEnvironment {
  t: UiDict;
  fmt: (iso: string) => string;
  now: () => number;
  mark: LucideIcon;
  appName: string;
  dialogNotice: ReactNode;
  errors: ErrorCatalog;
}

const defaultFmt = (lang: UiLang) => (iso: string) =>
  new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

const UiContext = createContext<UiValue>({
  lang: "de",
  t: de,
  fmt: defaultFmt("de"),
  now: () => Date.now(),
  mark: Box,
  appName: "",
  dialogNotice: null,
  errors: NO_ERROR_CATALOG,
});

export function UiProvider({
  children,
  lang,
  fmt,
  server,
  onReport,
  now,
  mark,
  appName,
  dialogNotice,
  errors,
}: UiEnvironment & { children: ReactNode }) {
  const value = useMemo<UiValue>(
    () => ({
      lang,
      t: uiDicts[lang],
      fmt: fmt ?? defaultFmt(lang),
      server,
      onReport,
      now: now ?? (() => Date.now()),
      mark: mark ?? Box,
      appName: appName ?? "",
      dialogNotice: dialogNotice ?? null,
      errors: errors ?? NO_ERROR_CATALOG,
    }),
    [lang, fmt, server, onReport, now, mark, appName, dialogNotice, errors],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useI18n() {
  const { t, lang, fmt } = useContext(UiContext);
  return { t, lang, fmt };
}

export function useUi() {
  const { server, onReport, now, mark, appName, dialogNotice, errors } = useContext(UiContext);
  return { server, onReport, now, mark, appName, dialogNotice, errors };
}
