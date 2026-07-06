// Outbound text formatter — converts the assistant's CommonMark/GFM into
// each chat platform's native plain-text dialect before it is sent.
//
// The LLM emits standard Markdown (`**bold**`, `- bullets`, `[t](url)`,
// bullet points). Slack (`mrkdwn`) and Google Chat's plain-text message
// field use NARROWER, DIFFERENT dialects — sending raw CommonMark makes
// them render literal `**` asterisks and bullet characters (the
// production bug this fixes). Teams and the sk CLI render full
// CommonMark / have their own renderer, so they pass through untouched.
//
// Applied at exactly ONE layer — `dispatcher.sendTracked`, immediately
// before `adapter.send`. Never call this a second time inside an adapter
// or it will double-convert (`**x**` -> `*x*` -> `x`).
//
// Dialect references:
//   Google Chat: https://developers.google.com/workspace/chat/format-messages
//   Slack mrkdwn: https://api.slack.com/reference/surfaces/formatting

import type { ChatPlatform } from "../types.ts";

/**
 * Convert `text` from CommonMark to `platform`'s native dialect.
 * Exhaustive over every ChatPlatform: slack + google_chat are
 * transformed; teams + sk_cli pass through verbatim.
 */
export function formatChatText(platform: ChatPlatform, text: string): string {
  switch (platform) {
    case "slack":
      return convert(text, "slack");
    case "google_chat":
      return convert(text, "google_chat");
    case "teams":
    case "sk_cli":
      return text;
    default: {
      // Exhaustiveness guard: a new platform must make an explicit
      // choice here rather than silently mangling or passing through.
      const _exhaustive: never = platform;
      return text;
    }
  }
}

type Dialect = "slack" | "google_chat";

// Private-use-area sentinel delimits protected code spans. This char
// can't appear in LLM prose and is inert to every transform below (not
// a `*`, `-`, `[`, `#`, or `\n`), so a protected span survives untouched.
const SENTINEL = "";

function convert(input: string, dialect: Dialect): string {
  if (!input) return input;

  // 1. Protect fenced + inline code so their contents are never rewritten.
  const protectedSpans: string[] = [];
  const protect = (raw: string): string => {
    const idx = protectedSpans.length;
    protectedSpans.push(raw);
    return `${SENTINEL}${idx}${SENTINEL}`;
  };
  let text = input
    // fenced blocks ```lang\n...\n``` — both dialects accept triple backtick, keep verbatim
    .replace(/```[\s\S]*?```/g, (m) => protect(m))
    // inline `code`
    .replace(/`[^`\n]+`/g, (m) => protect(m));

  // 2. Line-level transforms (headers, bullet markers).
  text = text
    .split("\n")
    .map((line) => transformLine(line, dialect))
    .join("\n");

  // 3. Inline transforms (bold before italic; links).
  text = transformInline(text, dialect);

  // 4. Restore protected code spans verbatim.
  text = text.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i) => protectedSpans[Number(i)] ?? "",
  );

  return text;
}

function transformLine(line: string, _dialect: Dialect): string {
  // ATX headers `# H` / `## H` -> a bold line (neither dialect has header
  // syntax). Emit CommonMark bold; the inline pass converts it to the
  // dialect's single-asterisk bold. Strip a trailing `#` run.
  const header = line.match(/^(\s*)#{1,6}\s+(.*)$/);
  if (header) {
    const indent = header[1] ?? "";
    const content = (header[2] ?? "").replace(/\s*#+\s*$/, "");
    return `${indent}**${content}**`;
  }

  // Bullet markers `-`, `*`, or a literal bullet char (the LLM emits one)
  // -> `*`. Both Slack and Google Chat accept `*`/`-`; normalizing to `*`
  // fixes the literal-bullet screenshot bug. Preserve leading indentation
  // so nested lists keep their depth.
  const bullet = line.match(/^(\s*)[-*•](\s+)(.*)$/);
  if (bullet) {
    const indent = bullet[1] ?? "";
    const space = bullet[2] ?? " ";
    const content = bullet[3] ?? "";
    return `${indent}*${space}${content}`;
  }

  // Numbered lists `1. text` and blockquotes `> text` pass through —
  // both dialects display them legibly with no transform.
  return line;
}

function transformInline(text: string, _dialect: Dialect): string {
  let out = text;

  // Links [text](url) -> <url|text> (both dialects share this).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => `<${url}|${label}>`);

  // Bold **text** / __text__ -> *text* (single asterisk, both dialects).
  // Run BEFORE any italic handling so `**` is consumed first.
  out = out.replace(/\*\*([^\n]+?)\*\*/g, (_m, inner) => `*${inner}*`);
  out = out.replace(/__([^\n]+?)__/g, (_m, inner) => `*${inner}*`);

  // Strikethrough ~~text~~ -> ~text~ (both dialects).
  out = out.replace(/~~([^\n]+?)~~/g, (_m, inner) => `~${inner}~`);

  // Italic: both dialects already use `_text_`, which CommonMark also
  // accepts, so `_..._` needs no change. CommonMark's other italic form
  // `*text*` is left as-is: after the bold pass above collapsed `**x**`
  // to `*x*`, a single-`*` pair is ambiguous with bold, so we let it
  // render as bold (an acceptable degradation) rather than risk
  // clobbering real bold. This sidesteps the bold/italic collision.

  return out;
}
