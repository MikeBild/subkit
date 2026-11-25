export const HIGHLIGHTS_FLAG = "--highlights";

const HEADING = /^##\s+Highlights\s+\(en\)\s*$/i;
const ANY_HEADING = /^##\s+Highlights\b/i;
const SECTION_END = /^#{1,2}\s/;

export const RELEASE_NOTES_PATH = "apps/cockpit/src/app/release-notes.generated.ts";

export function bareVersion(version: string): string {
  return version.replace(/^v/, "");
}

export function committedHighlightsProblems(
  version: string,
  committed: readonly string[],
  given: readonly string[],
): string[] {
  if (committed.length === 0)
    return [
      `the committed release notes have no highlights for ${bareVersion(version)} — run ` +
        `bun run gen release-notes ${HIGHLIGHTS_FLAG} <file> and commit ${RELEASE_NOTES_PATH}`,
    ];
  if (given.length > 0 && given.join("\n") !== committed.join("\n"))
    return [
      `the highlights given for ${bareVersion(version)} differ from the committed release notes — ` +
        `regenerate with bun run gen release-notes ${HIGHLIGHTS_FLAG} <file> and commit`,
    ];
  return [];
}

export function notesSection(notes: string): string {
  const trimmed = notes.trim();
  return trimmed ? `## Notes\n\n${trimmed}\n` : "";
}

export function parseHighlights(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(\S.*?)\s*$/.exec(line)?.[1] ?? null)
    .filter((bullet): bullet is string => bullet !== null && bullet.length > 0);
}

export function highlightsFromBody(body: string): string[] {
  const found: string[] = [];
  let inside = false;
  let lines: string[] = [];
  const close = () => {
    if (inside) found.push(...parseHighlights(lines.join("\n")));
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.test(line);
    if (heading || SECTION_END.test(line)) {
      close();
      inside = heading;
      lines = [];
    } else if (inside) lines.push(line);
  }
  close();
  return found;
}

export function otherHighlightsHeading(body: string): string | null {
  return (
    body
      .split(/\r?\n/)
      .find((line) => ANY_HEADING.test(line) && !HEADING.test(line))
      ?.trim() ?? null
  );
}

export function renderHighlights(en: readonly string[]): string {
  return `## Highlights (en)\n\n${en.map((line) => `- ${line}`).join("\n")}\n`;
}

export function withoutHighlights(body: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of body.split(/\r?\n/)) {
    if (ANY_HEADING.test(line)) skipping = true;
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
): Record<string, string[]> {
  const byVersion: Record<string, string[]> = {};
  for (const release of releases) {
    if (release.draft) continue;
    const highlights = highlightsFromBody(release.body ?? "");
    if (highlights.length > 0) byVersion[bareVersion(release.tag_name)] = highlights;
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
