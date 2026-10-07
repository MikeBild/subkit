export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "sk-cockpit-theme";

export interface ThemeEnvironment {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  prefersDark(): boolean;
  apply(theme: ResolvedTheme): void;
  share(theme: ResolvedTheme | null): void;
  watchSystem(listener: () => void): void;
}

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

export function createThemeStore(env: ThemeEnvironment) {
  const listeners = new Set<() => void>();
  function read() {
    const stored = env.read(THEME_STORAGE_KEY);
    const theme: Theme = isTheme(stored) ? stored : "system";
    const resolved: ResolvedTheme =
      theme === "system" ? (env.prefersDark() ? "dark" : "light") : theme;
    return { theme, resolved };
  }
  let current = read();
  env.apply(current.resolved);
  if (current.theme !== "system") env.share(current.theme);
  function publish(): void {
    const next = read();
    if (next.theme === current.theme && next.resolved === current.resolved) return;
    const chosen = next.theme !== current.theme;
    current = next;
    env.apply(current.resolved);
    if (chosen && current.theme !== "system") env.share(current.theme);
    for (const listener of listeners) listener();
  }
  env.watchSystem(publish);
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
    set(theme: Theme) {
      if (theme === "system") {
        env.remove(THEME_STORAGE_KEY);
        env.share(null);
      } else env.write(THEME_STORAGE_KEY, theme);
      publish();
    },
  };
}
