import { useSyncExternalStore } from "react";
import { sharePreference, THEME_COOKIE } from "./preference-cookie";
import { createThemeStore, type Theme } from "./theme-store";

const media =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");
const store = createThemeStore({
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
  prefersDark: () => media?.matches ?? false,
  apply: (resolved) => {
    if (typeof document !== "undefined")
      document.documentElement.classList.toggle("dark", resolved === "dark");
  },
  share: (theme) => sharePreference(THEME_COOKIE, theme),
  watchSystem: (listener) => media?.addEventListener("change", listener),
});

export function useTheme() {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...snapshot, setTheme: store.set };
}

export type { Theme };
