import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCALE_COOKIE, preferenceCookie, THEME_COOKIE } from "@/lib/preference-cookie";
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
  const shared: (ResolvedTheme | null)[] = [];
  let dark = prefersDark;
  let systemListener = () => {};
  const env: ThemeEnvironment = {
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
    prefersDark: () => dark,
    apply: (theme) => applied.push(theme),
    share: (theme) => shared.push(theme),
    watchSystem: (listener) => {
      systemListener = listener;
    },
  };
  return {
    env,
    storage,
    applied,
    shared,
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

  test("tells engine pages the choice on boot and on every change, and nothing for system", () => {
    const fake = environment("dark", false);
    const store = createThemeStore(fake.env);
    expect(fake.shared).toEqual(["dark"]);
    store.set("light");
    store.set("system");
    expect(fake.shared).toEqual(["dark", "light", null]);
    fake.setSystem(true);
    expect(fake.shared).toEqual(["dark", "light", null]);
    const boot = environment(null, true);
    createThemeStore(boot.env);
    expect(boot.shared).toEqual([null]);
  });

  test("tracks operating-system changes in system mode", () => {
    const fake = environment(null, false);
    const store = createThemeStore(fake.env);
    fake.setSystem(true);
    expect(store.snapshot().resolved).toBe("dark");
  });
});

describe("the preference cookie engine pages read", () => {
  test("is same-site, readable by the page and sent everywhere", () => {
    expect(preferenceCookie(THEME_COOKIE, "dark", true)).toBe(
      "sk_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(preferenceCookie(LOCALE_COOKIE, "de", false)).toBe(
      "sk_locale=de; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(preferenceCookie(THEME_COOKIE, "dark", true)).not.toContain("HttpOnly");
  });

  test("an automatic preference clears the cookie instead of freezing one value", () => {
    expect(preferenceCookie(THEME_COOKIE, null, false)).toBe(
      "sk_theme=; Path=/; Max-Age=0; SameSite=Lax",
    );
  });

  test("carries the names the engine reads", () => {
    const engine = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/http/routes/oauth/ui.ts"),
      "utf8",
    );
    expect(engine).toContain(`export const LOCALE_COOKIE = "${LOCALE_COOKIE}";`);
    expect(engine).toContain(`export const THEME_COOKIE = "${THEME_COOKIE}";`);
  });
});
