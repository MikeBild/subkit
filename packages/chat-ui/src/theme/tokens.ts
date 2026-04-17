// Centralized theme tokens — color map for every role and severity
// used by the chat UI. Replaces the ad-hoc `color=` props sprinkled
// across the existing Ink components. Both `sk` and `subkit chat`
// read the same tokens so their visual language matches.
//
// Auto-detection of dark/light terminals is out of scope; the chosen
// palette reads well on the default Ink (white-on-black) background.

export interface ThemeTokens {
  /** Role colors. */
  role: {
    user: string;
    assistant: string;
    tool: string;
    system: string;
  };
  /** Severity colors used for errors, warnings, and info. */
  severity: {
    error: string;
    warning: string;
    info: string;
    dim: string;
  };
  /** Mode-banner colors (plan / auto / ask). */
  mode: {
    plan: string;
    auto: string;
    ask: string;
  };
  /** Emphasis + highlight colors used by diff views and destructive confirms. */
  emphasis: {
    /** Added lines in diffs. */
    added: string;
    /** Removed lines in diffs. */
    removed: string;
    /** Destructive action title. */
    destructive: string;
  };
}

export const defaultTheme: ThemeTokens = {
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
    dim: "gray",
  },
  mode: {
    plan: "cyan",
    auto: "yellow",
    ask: "green",
  },
  emphasis: {
    added: "green",
    removed: "red",
    destructive: "red",
  },
};
