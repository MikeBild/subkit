export type HighlightLanguage = "en" | "de";
export type Highlights = Record<HighlightLanguage, string[]>;

export const HIGHLIGHTS_FLAG = "--highlights";

const HEADING = /^##\s+Highlights\s+\((de|en)\)\s*$/i;
const SECTION_END = /^#{1,2}\s/;

export function bareVersion(version: string): string {
  return version.replace(/^v/, "");
}

export function parseHighlights(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(\S.*?)\s*$/.exec(line)?.[1] ?? null)
    .filter((bullet): bullet is string => bullet !== null && bullet.length > 0);
}

export function highlightsFromBody(body: string): Partial<Highlights> {
  const found: Partial<Highlights> = {};
  let language: HighlightLanguage | null = null;
  let lines: string[] = [];
  const close = () => {
    if (language === null) return;
    const bullets = parseHighlights(lines.join("\n"));
    if (bullets.length > 0) found[language] = bullets;
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading || SECTION_END.test(line)) {
      close();
      language = heading ? (heading[1]?.toLowerCase() as HighlightLanguage) : null;
      lines = [];
    } else if (language !== null) lines.push(line);
  }
  close();
  return found;
}

export function completeHighlights(found: Partial<Highlights> | undefined): Highlights | null {
  if (!found) return null;
  const { de, en } = found;
  return de?.length && en?.length ? { en, de } : null;
}

export function renderHighlights(en: readonly string[]): string {
  return `## Highlights (en)\n\n${en.map((line) => `- ${line}`).join("\n")}\n`;
}

export function withoutHighlights(body: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.split(/\r?\n/)) {
    if (HEADING.test(line)) skipping = true;
    else if (SECTION_END.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim();
}

export function releaseBody(en: readonly string[] | null, rest: string): string {
  const others = withoutHighlights(rest);
  const head = en?.length ? renderHighlights(en) : "";
  if (!head) return others ? `${others}\n` : "";
  return others ? `${head}\n${others}\n` : head;
}

export type PublishedRelease = { tag_name: string; body: string | null; draft: boolean };

export function highlightsFromReleases(
  releases: readonly PublishedRelease[],
): Record<string, Partial<Highlights>> {
  const byVersion: Record<string, Partial<Highlights>> = {};
  for (const release of releases) {
    if (release.draft) continue;
    const en = highlightsFromBody(release.body ?? "").en;
    if (en?.length) byVersion[bareVersion(release.tag_name)] = { en };
  }
  return byVersion;
}

export function splitHighlightsFlag(args: readonly string[]): {
  path: string | null;
  rest: string[];
  error: string | null;
} {
  const rest: string[] = [];
  let path: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === HIGHLIGHTS_FLAG) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        return { path: null, rest: [], error: `${HIGHLIGHTS_FLAG} needs a file path` };
      path = value;
      index += 1;
    } else if (arg.startsWith(`${HIGHLIGHTS_FLAG}=`)) path = arg.slice(HIGHLIGHTS_FLAG.length + 1);
    else rest.push(arg);
  }
  return { path, rest, error: null };
}
