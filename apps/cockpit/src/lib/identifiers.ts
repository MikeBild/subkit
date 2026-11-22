import { escapeMarkdownLinkText } from "@shared/markdown-escape.ts";

interface TextSegment {
  text: string;
  code: boolean;
}

const CODE_PATTERN = /(```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`)/g;

export function splitCodeAndProse(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), code: false });
    segments.push({ text: match[0], code: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments;
}

export interface ResolvedIdentifier {
  label: string;
  href?: string | null;
}

const IDENTIFIER_PATTERN =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/gi;

function bareIdentifier(segment: TextSegment): string | null {
  if (!segment.code || segment.text.startsWith("```")) return null;
  const inner = segment.text.replace(/^`+|`+$/g, "").trim();
  return new RegExp(`^${IDENTIFIER_PATTERN.source}$`, "i").test(inner) ? inner : null;
}

const LINK_TARGET_PATTERN =
  /\]\((?:\\.|[^\\)\n])*\)|(?:https?:\/\/|\/(?:v1|cockpit)\/)[^\s<>`]+|^ {0,3}\[[^\]\n]+\]:[^\n]+/gm;

function nameProse(text: string, name: (id: string) => string): string {
  let result = "";
  let end = 0;
  for (const match of text.matchAll(LINK_TARGET_PATTERN)) {
    const start = match.index ?? 0;
    result += text.slice(end, start).replace(IDENTIFIER_PATTERN, name);
    result += match[0];
    end = start + match[0].length;
  }
  return result + text.slice(end).replace(IDENTIFIER_PATTERN, name);
}

export function nameIdentifiers(
  text: string,
  resolve: (id: string) => ResolvedIdentifier | null,
  hiddenLabel: string,
): string {
  const name = (id: string): string => {
    const known = resolve(id);
    if (!known) return hiddenLabel;
    const label = escapeMarkdownLinkText(known.label);
    return known.href ? `[${label}](${known.href})` : label;
  };
  return splitCodeAndProse(text)
    .map((segment) => {
      const bare = bareIdentifier(segment);
      if (bare) return name(bare);
      if (segment.code) return segment.text;
      return nameProse(segment.text, name);
    })
    .join("");
}
