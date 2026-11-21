export type ThemeName = "dark" | "light" | "highContrast" | "noColor";

export interface ThemeTokens {
  role: {
    user: string;
    assistant: string;
    tool: string;
    system: string;
  };
  severity: {
    error: string;
    warning: string;
    info: string;
    success: string;
    neutral: string;
    dim: string;
  };
  emphasis: {
    strong: string;
    normal: string;
    dim: string;
    faint: string;
    added: string;
    removed: string;
    destructive: string;
  };
  surface: {
    bg: string;
    panel: string;
    overlay: string;
    raised: string;
  };
  border: {
    default: string;
    focus: string;
    muted: string;
    strong: string;
  };
  accent: {
    primary: string;
    secondary: string;
    link: string;
  };
  chrome: {
    header: string;
    footer: string;
    statusBar: string;
    modal: string;
  };
  gutter: {
    default: string;
    active: string;
    assistant: string;
    user: string;
    tool: string;
  };
  cursor: {
    block: string;
    bar: string;
  };
  diff: {
    added: string;
    removed: string;
    hunkHeader: string;
    context: string;
  };
  spinner: {
    frame: string;
    label: string;
  };
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

export const defaultTheme: ThemeTokens = darkTheme;

export function paletteFor(name: ThemeName | undefined): ThemeTokens {
  if (!name) return defaultTheme;
  return PALETTES[name] ?? defaultTheme;
}

export function shouldForceNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SK_PLAIN === "1" || env.SK_PLAIN === "true") return true;
  return env.NO_COLOR != null && env.NO_COLOR !== "";
}
