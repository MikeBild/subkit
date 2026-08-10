import { describe, expect, test } from "bun:test";
import {
  createThemeStore,
  type ResolvedTheme,
  THEME_STORAGE_KEY,
  type ThemeEnvironment,
} from "@/lib/theme-store";

function environment(stored: string | null, prefersDark: boolean) {
  const storage = new Map<string, string>();
  if (stored) storage.set(THEME_STORAGE_KEY, stored);
  const applied: ResolvedTheme[] = [];
  let dark = prefersDark;
  let systemListener = () => {};
  const env: ThemeEnvironment = {
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
    prefersDark: () => dark,
    apply: (theme) => applied.push(theme),
    watchSystem: (listener) => {
      systemListener = listener;
    },
  };
  return {
    env,
    storage,
    applied,
    setSystem(value: boolean) {
      dark = value;
      systemListener();
    },
  };
}

describe("cockpit theme", () => {
  test("follows the system by default", () => {
    expect(createThemeStore(environment(null, true).env).snapshot()).toEqual({
      theme: "system",
      resolved: "dark",
    });
  });

  test("persists explicit choices and removes them for system mode", () => {
    const fake = environment(null, false);
    const store = createThemeStore(fake.env);
    store.set("dark");
    expect(fake.storage.get(THEME_STORAGE_KEY)).toBe("dark");
    store.set("system");
    expect(fake.storage.has(THEME_STORAGE_KEY)).toBe(false);
  });

  test("tracks operating-system changes in system mode", () => {
    const fake = environment(null, false);
    const store = createThemeStore(fake.env);
    fake.setSystem(true);
    expect(store.snapshot().resolved).toBe("dark");
  });
});
