export interface FeedFile {
  url: string;
  sha512: string;
  size: number | null;
}

export interface Feed {
  version: string;
  files: FeedFile[];
  staged: boolean;
}

export interface ArtifactFacts {
  sha512: string;
  size: number;
}

export const RELEASE_FEEDS = ["latest-mac.yml", "latest.yml"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readFeed(value: unknown): Feed | null {
  const feed = record(value);
  if (!feed || typeof feed.version !== "string" || !Array.isArray(feed.files)) return null;
  const files: FeedFile[] = [];
  for (const entry of feed.files) {
    const file = record(entry);
    if (!file || typeof file.url !== "string" || typeof file.sha512 !== "string") return null;
    files.push({
      url: file.url,
      sha512: file.sha512,
      size: typeof file.size === "number" ? file.size : null,
    });
  }
  return { version: feed.version, files, staged: "stagingPercentage" in feed };
}

export function feedProblems(
  feed: Feed,
  version: string,
  artifacts: ReadonlyMap<string, ArtifactFacts>,
): string[] {
  const problems: string[] = [];
  if (feed.version !== version)
    problems.push(`names version ${feed.version} instead of ${version}`);
  if (feed.staged) problems.push("carries a staged rollout percentage");
  if (!feed.files.length) problems.push("lists no file");
  for (const file of feed.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.url)) {
      problems.push(`lists ${file.url}, which is not a plain file name of this release`);
      continue;
    }
    const artifact = artifacts.get(file.url);
    if (!artifact) {
      problems.push(`lists ${file.url}, which is not among the artifacts`);
      continue;
    }
    if (artifact.sha512 !== file.sha512) problems.push(`has another SHA-512 for ${file.url}`);
    if (file.size !== null && artifact.size !== file.size)
      problems.push(`has another size for ${file.url}`);
  }
  return problems;
}
