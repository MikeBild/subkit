// Theme context — components read color tokens through `useTheme`
// rather than hard-coding Ink color strings. The host CLI may inject
// an override at mount time (e.g., to support a dim-background
// terminal); by default every component picks up `defaultTheme` from
// `./tokens.ts`.

import { createContext, useContext } from "react";
import { defaultTheme, type ThemeTokens } from "./tokens.ts";

const ThemeContext = createContext<ThemeTokens>(defaultTheme);

export interface ThemeProviderProps {
  value?: ThemeTokens;
  children: React.ReactNode;
}

export function ThemeProvider({ value, children }: ThemeProviderProps): React.ReactElement {
  return <ThemeContext.Provider value={value ?? defaultTheme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}
