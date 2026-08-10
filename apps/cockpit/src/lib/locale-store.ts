import { LOCALES, type Locale } from "./i18n";

export type LocalePreference = Locale | "auto";
export const LOCALE_STORAGE_KEY = "sk-cockpit-locale";

export interface LocaleSnapshot {
  preference: LocalePreference;
  locale: Locale;
}

export interface LocaleEnvironment {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  languages(): readonly string[];
  apply(locale: Locale): void;
  watch?(listener: () => void): void;
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.trim().toLowerCase().split("-")[0];
    if (base === "de" || base === "en") return base;
  }
  return "en";
}

function isLocale(value: string | null): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export function createLocaleStore(env: LocaleEnvironment) {
  const listeners = new Set<() => void>();
  function read(): LocaleSnapshot {
    const stored = env.read(LOCALE_STORAGE_KEY);
    const preference: LocalePreference = isLocale(stored) ? stored : "auto";
    return {
      preference,
      locale: preference === "auto" ? resolveLocale(env.languages()) : preference,
    };
  }
  let current = read();
  env.apply(current.locale);

  function publish(): void {
    const next = read();
    if (next.preference === current.preference && next.locale === current.locale) return;
    current = next;
    env.apply(current.locale);
    for (const listener of listeners) listener();
  }
  env.watch?.(publish);

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
    set(preference: LocalePreference) {
      if (preference === "auto") env.remove(LOCALE_STORAGE_KEY);
      else env.write(LOCALE_STORAGE_KEY, preference);
      publish();
    },
  };
}
