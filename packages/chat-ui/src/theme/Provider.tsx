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
  value?: ThemeTokens;
  name?: ThemeName;
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

export function useTheme(): ThemeTokens {
  return useContext(ThemeContext).tokens;
}

export function useThemeControl(): { name: ThemeName; setTheme: (n: ThemeName) => void } {
  const ctx = useContext(ThemeContext);
  return { name: ctx.name, setTheme: ctx.setTheme };
}
