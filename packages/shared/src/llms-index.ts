export interface LlmsPage {
  path: string;
  title: string;
  summary: string;
}

export const LLMS_PAGE_PATHS: ReadonlyArray<string> = [
  "setup.md",
  "coding-agents.md",
  "cli.md",
  "settings.md",
  "connectors.md",
  "transactional-email.md",
];

export interface RenderLlmsIndexOptions {
  linkFor: (page: LlmsPage) => string;
  fullUrl: string;
}

export function renderLlmsIndex(pages: LlmsPage[], opts: RenderLlmsIndexOptions): string {
  const lines = [
    "# sk",
    "",
    "> A self-hosted engine for governed workflows. These pages describe setup, coding-agent briefings and hooks, the sk CLI, runtime settings, the connector catalog, and governed transactional email.",
    `> All pages in one file: ${opts.fullUrl}`,
    "",
    "## Pages",
    "",
  ];
  for (const page of pages) {
    const summary = page.summary ? `: ${page.summary}` : "";
    lines.push(`- [${page.title}](${opts.linkFor(page)})${summary}`);
  }
  return lines.join("\n");
}
