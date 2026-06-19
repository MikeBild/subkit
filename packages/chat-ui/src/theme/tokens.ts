// Centralized theme tokens — color map for every role, severity, and
// chrome surface used by the chat UI. Components consume tokens via
// `useTheme()`; never embed raw Ink color strings outside this module.
//
// Both `sk` and `subkit chat` read the same tokens so their visual
// language matches. The token surface intentionally over-covers what
// the CLI uses today so future components (toasts, panels, diffs,
// virtual transcript gutters, error panels) can pull from one source.
//
// Palettes ship with four named variants:
//   - "dark"          — default, reads well on white-on-black terminals
//   - "light"         — readable on light-background terminals
//   - "highContrast"  — accessibility variant, no greys
//   - "noColor"       — every token resolves to the empty string so the
//                       Ink renderer falls back to the terminal's
//                       default foreground (honors NO_COLOR / SK_PLAIN)

export type ThemeName = "dark" | "light" | "highContrast" | "noColor";

export interface ThemeTokens {
  /** Speaker / origin of a message line. */
  role: {
    user: string;
    assistant: string;
    tool: string;
    system: string;
  };
  /** Outcome severity used for errors, warnings, hints, success states. */
  severity: {
    error: string;
    warning: string;
    info: string;
    success: string;
    neutral: string;
    dim: string;
  };
  /** Mode banner colors (plan / auto / ask / yolo).
   *  yolo intentionally renders red — operators must see it on every
   *  turn, not just the status line. */
  mode: {
    plan: string;
    auto: string;
    ask: string;
    yolo: string;
    interactive: string;
    headless: string;
  };
  /** Emphasis + highlight colors used by diff views, destructive confirms,
   *  and inline annotations. */
  emphasis: {
    strong: string;
    normal: string;
    dim: string;
    faint: string;
    /** Added lines in diffs. */
    added: string;
    /** Removed lines in diffs. */
    removed: string;
    /** Destructive action title. */
    destructive: string;
  };
  /** Block surfaces — backgrounds for cards, modals, and the panel chrome. */
  surface: {
    bg: string;
    panel: string;
    overlay: string;
    raised: string;
  };
  /** Border colors used by panels, focused inputs, and dividers. */
  border: {
    default: string;
    focus: string;
    muted: string;
    strong: string;
  };
  /** Accent palette — links, primary CTAs, secondary callouts. */
  accent: {
    primary: string;
    secondary: string;
    link: string;
  };
  /** Chrome regions — header, footer, status bar, modal frame. */
  chrome: {
    header: string;
    footer: string;
    statusBar: string;
    modal: string;
  };
  /** Gutter glyph + tone used by VirtualTranscript / MessageGutter. */
  gutter: {
    default: string;
    active: string;
    assistant: string;
    user: string;
    tool: string;
  };
  /** Cursor + selection. */
  cursor: {
    block: string;
    bar: string;
  };
  /** Diff renderer extras (hunk header, context). */
  diff: {
    added: string;
    removed: string;
    hunkHeader: string;
    context: string;
  };
  /** Spinner colors — `frame` is the rotating glyph, `label` is the verb. */
  spinner: {
    frame: string;
    label: string;
  };
  /** Status badges (run history, tool-call chips). */
  badge: {
    ok: string;
    warn: string;
    fail: string;
    neutral: string;
  };
}

const darkTheme: ThemeTokens = {
  role: {
    user: "green",
    assistant: "cyan",
    tool: "yellow",
    system: "magenta",
  },
  severity: {
    error: "red",
    warning: "yellow",
    info: "white",
    success: "green",
    neutral: "gray",
    dim: "gray",
  },
  mode: {
    plan: "cyan",
    auto: "yellow",
    ask: "green",
    yolo: "red",
    interactive: "cyan",
    headless: "gray",
  },
  emphasis: {
    strong: "white",
    normal: "white",
    dim: "gray",
    faint: "blackBright",
    added: "green",
    removed: "red",
    destructive: "red",
  },
  surface: {
    bg: "",
    panel: "",
    overlay: "",
    raised: "",
  },
  border: {
    default: "gray",
    focus: "cyan",
    muted: "blackBright",
    strong: "white",
  },
  accent: {
    primary: "cyan",
    secondary: "magenta",
    link: "blue",
  },
  chrome: {
    header: "cyan",
    footer: "gray",
    statusBar: "blackBright",
    modal: "white",
  },
  gutter: {
    default: "gray",
    active: "cyan",
    assistant: "cyan",
    user: "green",
    tool: "yellow",
  },
  cursor: {
    block: "white",
    bar: "white",
  },
  diff: {
    added: "green",
    removed: "red",
    hunkHeader: "cyan",
    context: "gray",
  },
  spinner: {
    frame: "cyan",
    label: "white",
  },
  badge: {
    ok: "green",
    warn: "yellow",
    fail: "red",
    neutral: "gray",
  },
};

const lightTheme: ThemeTokens = {
  ...darkTheme,
  role: {
    user: "blue",
    assistant: "magenta",
    tool: "yellow",
    system: "magentaBright",
  },
  severity: {
    error: "red",
    warning: "yellow",
    info: "black",
    success: "green",
    neutral: "blackBright",
    dim: "blackBright",
  },
  emphasis: {
    strong: "black",
    normal: "black",
    dim: "blackBright",
    faint: "gray",
    added: "green",
    removed: "red",
    destructive: "red",
  },
  border: {
    default: "blackBright",
    focus: "blue",
    muted: "gray",
    strong: "black",
  },
  chrome: {
    header: "blue",
    footer: "blackBright",
    statusBar: "gray",
    modal: "black",
  },
  gutter: {
    default: "blackBright",
    active: "blue",
    assistant: "magenta",
    user: "blue",
    tool: "yellow",
  },
  cursor: {
    block: "black",
    bar: "black",
  },
  spinner: {
    frame: "blue",
    label: "black",
  },
};

const highContrastTheme: ThemeTokens = {
  ...darkTheme,
  role: {
    user: "greenBright",
    assistant: "cyanBright",
    tool: "yellowBright",
    system: "magentaBright",
  },
  severity: {
    error: "redBright",
    warning: "yellowBright",
    info: "whiteBright",
    success: "greenBright",
    neutral: "white",
    dim: "white",
  },
  emphasis: {
    strong: "whiteBright",
    normal: "white",
    dim: "white",
    faint: "white",
    added: "greenBright",
    removed: "redBright",
    destructive: "redBright",
  },
  border: {
    default: "white",
    focus: "cyanBright",
    muted: "white",
    strong: "whiteBright",
  },
  badge: {
    ok: "greenBright",
    warn: "yellowBright",
    fail: "redBright",
    neutral: "white",
  },
};

/** Every token resolves to the empty string. Ink treats `color=""` as
 *  "no override" and falls back to the terminal's default foreground.
 *  This honors NO_COLOR / SK_PLAIN without any conditional rendering. */
const noColorTheme: ThemeTokens = (() => {
  const base = darkTheme;
  const blank = (() => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(base.role)) out[k] = "";
    return out;
  })();
  return {
    role: { user: "", assistant: "", tool: "", system: "" },
    severity: { error: "", warning: "", info: "", success: "", neutral: "", dim: "" },
    mode: { plan: "", auto: "", ask: "", yolo: "", interactive: "", headless: "" },
    emphasis: {
      strong: "",
      normal: "",
      dim: "",
      faint: "",
      added: "",
      removed: "",
      destructive: "",
    },
    surface: { bg: "", panel: "", overlay: "", raised: "" },
    border: { default: "", focus: "", muted: "", strong: "" },
    accent: { primary: "", secondary: "", link: "" },
    chrome: { header: "", footer: "", statusBar: "", modal: "" },
    gutter: { default: "", active: "", assistant: "", user: "", tool: "" },
    cursor: { block: "", bar: "" },
    diff: { added: "", removed: "", hunkHeader: "", context: "" },
    spinner: { frame: "", label: "" },
    badge: { ok: "", warn: "", fail: "", neutral: "" },
  } satisfies ThemeTokens & typeof blank extends never ? never : ThemeTokens;
})();

export const PALETTES: Record<ThemeName, ThemeTokens> = {
  dark: darkTheme,
  light: lightTheme,
  highContrast: highContrastTheme,
  noColor: noColorTheme,
};

/** Default-exported palette stays the dark theme so existing callers
 *  see no behavior change. */
export const defaultTheme: ThemeTokens = darkTheme;

/** Resolve a palette by name. Unknown names fall back to dark. */
export function paletteFor(name: ThemeName | undefined): ThemeTokens {
  if (!name) return defaultTheme;
  return PALETTES[name] ?? defaultTheme;
}

/** True when the runtime should force the noColor palette regardless of
 *  the requested theme. Honors the standard NO_COLOR env (no-color.org)
 *  and our project-local `SK_PLAIN=1` opt-in. */
export function shouldForceNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SK_PLAIN === "1" || env.SK_PLAIN === "true") return true;
  // NO_COLOR is opt-in by mere presence per https://no-color.org
  return env.NO_COLOR != null && env.NO_COLOR !== "";
}
