// Terminal hyperlink (OSC 8) helper — shared by the chat-ui components AND
// the sk CLI so every URL render site behaves identically.
//
// Emits `\x1b]8;;URL\x07TEXT\x1b]8;;\x07` when the terminal supports OSC 8,
// and falls back to the PLAIN url otherwise — never terminal-link's default
// `text url` space-join, which corrupts copy-paste. Color is left to the
// caller's Ink <Text color> so strip-ansi width math is unaffected (baked
// SGR would break Ink's layout measurement).
//
// Why our own detection instead of just terminal-link: terminal-link's
// isSupported is conservative (returns false for Apple Terminal, which has
// rendered OSC 8 since macOS 15, and for kitty/ghostty in some setups).
// Gating solely on it would REGRESS the previously always-on ConfirmPrompt
// link path to plain text. We OR it with an explicit modern-terminal
// allowlist so clickability stays broad, while non-TTY / unknown
// terminals still get a clean copyable URL.

import terminalLink from "terminal-link";

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x07";

// TERM_PROGRAM / LC_TERMINAL values for terminals that render OSC 8.
const HYPERLINK_TERMINALS = new Set([
  "iTerm.app",
  "iTerm2",
  "Apple_Terminal",
  "WezTerm",
  "ghostty",
  "vscode",
  "Hyper",
  "kitty",
  "alacritty",
  "rio",
  "tabby",
]);

function detectHyperlinkSupport(env: NodeJS.ProcessEnv = process.env): boolean {
  // Explicit operator override — `SK_FORCE_HYPERLINKS=1` forces OSC 8 on
  // (e.g. a terminal we don't auto-detect, or over ssh/tmux where the
  // user knows their client renders links); `=0` forces plain URLs.
  const forced = env.SK_FORCE_HYPERLINKS;
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;
  // Non-TTY (pipes, `/respond`-via-copy, CI capture) → plain URL so the
  // raw text is copyable and no escapes leak into captured output.
  if (process.stdout && process.stdout.isTTY !== true) return false;
  if (terminalLink.isSupported) return true;
  const program = env.TERM_PROGRAM;
  if (program && HYPERLINK_TERMINALS.has(program)) return true;
  // LC_TERMINAL survives tmux, which overwrites TERM_PROGRAM to "tmux".
  const lcTerminal = env.LC_TERMINAL;
  if (lcTerminal && HYPERLINK_TERMINALS.has(lcTerminal)) return true;
  if (env.WT_SESSION) return true; // Windows Terminal
  const term = env.TERM ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) return true;
  return false;
}

let cachedSupport: boolean | null = null;

/** Whether the current terminal renders OSC 8 hyperlinks (cached). */
export function terminalSupportsHyperlinks(): boolean {
  if (cachedSupport === null) cachedSupport = detectHyperlinkSupport();
  return cachedSupport;
}

/** Test-only: reset the memoized support decision. */
export function resetHyperlinkSupportCacheForTests(): void {
  cachedSupport = null;
}

/**
 * Render `url` as a clickable OSC 8 hyperlink when supported, else as the
 * plain url (copyable). `displayText` defaults to the full url so a copy
 * always yields the url even on supported terminals. Pass `supported`
 * explicitly in tests for determinism.
 */
export function hyperlink(url: string, displayText?: string, supported?: boolean): string {
  const text = displayText ?? url;
  const ok = supported ?? terminalSupportsHyperlinks();
  if (!ok) return text === url ? url : `${text}: ${url}`;
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`;
}

// Match http/https URLs up to whitespace, trimming a trailing sentence
// terminator so prose like "see https://x.com." doesn't capture the dot.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/**
 * Rewrite every URL token in `text` as a hyperlink (clickable when
 * supported, plain otherwise). Non-URL prose is left untouched. Each URL
 * becomes a single click target so terminal word-wrap never splits it.
 */
export function renderTextWithLinks(text: string, supported?: boolean): string {
  return text.replace(URL_PATTERN, (match) => hyperlink(match, undefined, supported));
}
