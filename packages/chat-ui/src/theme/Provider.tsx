// Theme context — components read color tokens through `useTheme`
// rather than hard-coding Ink color strings. The host CLI may inject
// either a fully-resolved `ThemeTokens` value or a named palette;
// `noColor` is forced automatically whenever NO_COLOR / SK_PLAIN is set.
//
// `setTheme(name)` exposes a runtime switch so the operator can flip
// dark/light/highContrast without restarting the REPL.

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import {
  defaultTheme,
  paletteFor,
  shouldForceNoColor,
  type ThemeName,
  type ThemeTokens,
} from "./tokens.ts";

interface ThemeContextValue {
  tokens: ThemeTokens;
  name: ThemeName;
  setTheme: (n: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  tokens: defaultTheme,
  name: "dark",
  setTheme: () => undefined,
});

export interface ThemeProviderProps {
  /** Optional explicit token override. If provided it wins over `name`. */
  value?: ThemeTokens;
  /** Initial palette name. Defaults to dark. Ignored if `value` is set. */
  name?: ThemeName;
  /** When true, ignore the requested palette and force noColor.
   *  When omitted, auto-detect via NO_COLOR / SK_PLAIN env. */
  forceNoColor?: boolean;
  children: React.ReactNode;
}

export function ThemeProvider({
  value,
  name,
  forceNoColor,
  children,
}: ThemeProviderProps): React.ReactElement {
  const initial: ThemeName = name ?? "dark";
  const [active, setActive] = useState<ThemeName>(initial);
  const setTheme = useCallback((n: ThemeName) => setActive(n), []);

  const ctx = useMemo<ThemeContextValue>(() => {
    const noColor = forceNoColor ?? shouldForceNoColor();
    const resolvedName: ThemeName = noColor ? "noColor" : active;
    const tokens = value ?? paletteFor(resolvedName);
    return { tokens, name: resolvedName, setTheme };
  }, [value, active, forceNoColor, setTheme]);

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}

/** Returns the active token map. Stable identity per palette switch. */
export function useTheme(): ThemeTokens {
  return useContext(ThemeContext).tokens;
}

/** Returns the active palette name + a setter for runtime switching. */
export function useThemeControl(): { name: ThemeName; setTheme: (n: ThemeName) => void } {
  const ctx = useContext(ThemeContext);
  return { name: ctx.name, setTheme: ctx.setTheme };
}
