import terminalLink from "terminal-link";

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x07";

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
  const forced = env.SUBKIT_FORCE_HYPERLINKS;
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;
  if (process.stdout && process.stdout.isTTY !== true) return false;
  if (terminalLink.isSupported) return true;
  const program = env.TERM_PROGRAM;
  if (program && HYPERLINK_TERMINALS.has(program)) return true;
  const lcTerminal = env.LC_TERMINAL;
  if (lcTerminal && HYPERLINK_TERMINALS.has(lcTerminal)) return true;
  if (env.WT_SESSION) return true;
  const term = env.TERM ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) return true;
  return false;
}

let cachedSupport: boolean | null = null;

export function terminalSupportsHyperlinks(): boolean {
  if (cachedSupport === null) cachedSupport = detectHyperlinkSupport();
  return cachedSupport;
}

export function resetHyperlinkSupportCacheForTests(): void {
  cachedSupport = null;
}

export function hyperlink(url: string, displayText?: string, supported?: boolean): string {
  const text = displayText ?? url;
  const ok = supported ?? terminalSupportsHyperlinks();
  if (!ok) return text === url ? url : `${text}: ${url}`;
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

export function renderTextWithLinks(text: string, supported?: boolean): string {
  return text.replace(URL_PATTERN, (match) => hyperlink(match, undefined, supported));
}
