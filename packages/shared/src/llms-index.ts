// Single source of truth for the llms.txt index FORMAT (see
// <https://llmstxt.org>). Both the build script (scripts/gen-llms-txt.ts,
// which writes the committed docs/llms.txt with repo-relative links) and the
// engine route (apps/engine/src/http/routes/llms-txt.ts, which serves the
// same index with self-hosted origin links) render through `renderLlmsIndex`
// so the two surfaces can never drift in shape — only the `linkFor`/`fullUrl`
// strategy differs.

/** One indexed documentation page. `path` is repo-root-relative. */
export interface LlmsPage {
  audience: string;
  /** Repo-root-relative, e.g. `docs/concepts/connectors.md`. */
  path: string;
  title: string;
  summary: string;
}

/**
 * Auto-generated reference pages. Per the llmstxt.org spec these belong under
 * an `## Optional` section ("URLs that can be skipped if a shorter context is
 * needed") rather than in the primary audience sections.
 */
export const OPTIONAL_PATHS: ReadonlySet<string> = new Set([
  "docs/admins/settings-reference.md",
  "docs/authors/settings.md",
  "docs/authors/slash-commands.md",
  "docs/developers/cli-reference.md",
]);

// Audience folder -> section heading, in emission order. Mirrors
// AUDIENCE_ORDER in scripts/gen-llms-txt.ts.
const AUDIENCE_LABELS: ReadonlyArray<{ dir: string; label: string }> = [
  { dir: "concepts", label: "Concepts" },
  { dir: "operators", label: "Operators" },
  { dir: "authors", label: "Authors" },
  { dir: "developers", label: "Developers" },
  { dir: "admins", label: "Admins" },
];

export interface RenderLlmsIndexOptions {
  /** Maps a page to the href used in its list entry. */
  linkFor: (page: LlmsPage) => string;
  /** Absolute or relative URL of the full-text variant, surfaced in the lede. */
  fullUrl: string;
  /**
   * Decides whether a page belongs under `## Optional`.
   * Defaults to `OPTIONAL_PATHS.has(page.path)`.
   */
  optional?: (page: LlmsPage) => boolean;
}

// README first, then by path — stable across runs.
function byReadmeThenPath(a: LlmsPage, b: LlmsPage): number {
  const ar = a.path.endsWith("/README.md");
  const br = b.path.endsWith("/README.md");
  if (ar !== br) return ar ? -1 : 1;
  return a.path.localeCompare(b.path);
}

function listEntry(page: LlmsPage, linkFor: (p: LlmsPage) => string): string {
  const summary = page.summary ? `: ${page.summary}` : "";
  return `- [${page.title}](${linkFor(page)})${summary}`;
}

/**
 * Render the byte-stable llms.txt index: H1, a `>` blockquote lede (including
 * the full-text pointer), one `## <Label>` section per audience with its
 * non-optional pages, then a final `## Optional` section if any page is
 * optional. The returned string has no trailing newline; callers append one.
 */
export function renderLlmsIndex(pages: LlmsPage[], opts: RenderLlmsIndexOptions): string {
  const isOptional = opts.optional ?? ((p: LlmsPage) => OPTIONAL_PATHS.has(p.path));

  const lines: string[] = [
    "# sk Documentation",
    "",
    "> The sk documentation set for LLMs: every public page grouped by audience, each with its title, link, and one-line summary.",
    `> Full documentation in one file: ${opts.fullUrl}`,
  ];

  for (const { dir, label } of AUDIENCE_LABELS) {
    const group = pages.filter((p) => p.audience === dir && !isOptional(p)).sort(byReadmeThenPath);
    if (group.length === 0) continue;

    lines.push("", `## ${label}`, "");
    for (const page of group) lines.push(listEntry(page, opts.linkFor));
  }

  const optional = pages.filter(isOptional).sort(byReadmeThenPath);
  if (optional.length > 0) {
    lines.push("", "## Optional", "");
    for (const page of optional) lines.push(listEntry(page, opts.linkFor));
  }

  return lines.join("\n");
}
