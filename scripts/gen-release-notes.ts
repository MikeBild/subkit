#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bareVersion,
  highlightsFromBody,
  highlightsFromReleases,
  otherHighlightsHeading,
  type PublishedRelease,
  splitHighlightsFlag,
} from "./lib/release-highlights.ts";
import { englishSubject } from "./lib/release-subjects.ts";

export type ReleaseNotes = {
  version: string;
  notes: string[];
  highlights: string[] | null;
};

export type PendingNotes = {
  version: string | null;
  notes: string[];
  highlights: string[] | null;
};

export type ReleaseHistory = {
  source: string;
  releases: ReleaseNotes[];
  unpublished: PendingNotes;
};

function userFacingSubject(subject: string): string | null {
  const match = /^(?:feat|fix)\(user\)!?:\s+(.+)$/.exec(subject.trim());
  return match?.[1]?.trim() || null;
}

export function releaseNotesFromSubjects(subjects: string[]): string[] {
  return subjects
    .map(userFacingSubject)
    .filter((subject): subject is string => subject !== null)
    .filter((subject, index, notes) => notes.indexOf(subject) === index);
}

export function releaseHistoryFromRanges(input: {
  source: string;
  releases: Array<{ version: string; subjects: string[] }>;
  unpublished: { version: string | null; subjects: string[] };
  highlights: Record<string, string[]>;
}): ReleaseHistory {
  const highlightsOf = (version: string | null) => {
    const found = version === null ? undefined : input.highlights[bareVersion(version)];
    return found?.length ? found : null;
  };
  return {
    source: input.source,
    releases: input.releases.map(({ version, subjects }) => ({
      version,
      notes: releaseNotesFromSubjects(subjects),
      highlights: highlightsOf(version),
    })),
    unpublished: {
      version: input.unpublished.version,
      notes: releaseNotesFromSubjects(input.unpublished.subjects),
      highlights: highlightsOf(input.unpublished.version),
    },
  };
}

export function knownHighlights(history: ReleaseHistory): Record<string, string[]> {
  const known: Record<string, string[]> = {};
  for (const release of history.releases)
    if (release.highlights) known[bareVersion(release.version)] = release.highlights;
  const pending = history.unpublished;
  if (pending.version && pending.highlights)
    known[bareVersion(pending.version)] = pending.highlights;
  return known;
}

export function mergeHighlights(
  ...sources: Array<Record<string, string[]> | null>
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const source of sources)
    for (const [version, highlights] of Object.entries(source ?? {}))
      if (highlights.length > 0) merged[version] = highlights;
  return merged;
}

export function pendingVersion(packageVersion: string, tags: string[]): string | null {
  return tags.includes(`v${bareVersion(packageVersion)}`) ? null : bareVersion(packageVersion);
}

const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function subjects(repo: string, range: string): string[] {
  if (!range) return [];
  return git(repo, ["log", "--no-merges", "--format=%H %s", range])
    .split("\n")
    .filter(Boolean)
    .map((line) => englishSubject(line.slice(0, 40), line.slice(41)));
}

function releaseTags(repo: string, target: string): string[] {
  return git(repo, ["tag", "--merged", target, "--list", "v*.*.*", "--sort=version:refname"])
    .split("\n")
    .filter(Boolean);
}

export function renderReleaseHistory(history: ReleaseHistory): string {
  return [
    "export type ReleaseNotes = { version: string; notes: string[]; highlights: string[] | null };",
    "",
    "export type PendingNotes = { version: string | null; notes: string[]; highlights: string[] | null };",
    "",
    `export const RELEASE_HISTORY: { source: string; releases: ReleaseNotes[]; unpublished: PendingNotes } = ${JSON.stringify(history, null, 2)};`,
    "",
  ].join("\n");
}

function packageVersionOf(repo: string, target: string): string {
  return (JSON.parse(git(repo, ["show", `${target}:package.json`])) as { version: string }).version;
}

export function generateReleaseHistory(
  repo: string,
  target: string,
  highlights: Record<string, string[]> = {},
): ReleaseHistory {
  const source = git(repo, ["rev-parse", target]);
  const tags = releaseTags(repo, target);
  const releases = tags.map((tag, index) => ({
    version: tag,
    subjects: subjects(repo, index === 0 ? tag : `${tags[index - 1]}..${tag}`),
  }));
  const latest = tags.at(-1);
  return releaseHistoryFromRanges({
    source,
    releases,
    unpublished: {
      version: pendingVersion(packageVersionOf(repo, source), tags),
      subjects: subjects(repo, latest ? `${latest}..${target}` : target),
    },
    highlights,
  });
}

export const RELEASES_URL = "https://api.github.com/repos/MikeBild/subkit/releases";

async function publishedReleases(): Promise<PublishedRelease[] | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "subkit-release-notes",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases: PublishedRelease[] = [];
  try {
    for (let page = 1; page <= 20; page += 1) {
      const response = await fetch(`${RELEASES_URL}?per_page=100&page=${page}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const batch = (await response.json()) as PublishedRelease[];
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
    return releases;
  } catch (error) {
    console.warn(
      `release notes: highlights of published releases not read from GitHub (${
        error instanceof Error ? error.message : String(error)
      }); keeping the committed ones`,
    );
    return null;
  }
}

async function committedHistory(output: string): Promise<ReleaseHistory | null> {
  if (!existsSync(output)) return null;
  return ((await import(output)) as { RELEASE_HISTORY: ReleaseHistory }).RELEASE_HISTORY;
}

if (import.meta.main) {
  const flags = splitHighlightsFlag(process.argv.slice(2));
  if (flags.error) throw new Error(flags.error);
  const argv = flags.rest;
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : (argv[index + 1] ?? "");
  };
  const repo = resolve(value("--repo") ?? defaultRepo);
  const output = resolve(
    value("--output") ?? `${repo}/apps/cockpit/src/app/release-notes.generated.ts`,
  );
  const check = argv.includes("--check");
  const offline = argv.includes("--offline");
  const release = value("--release");
  const committed = await committedHistory(output);
  const target = check && release === undefined ? committed?.source : (release ?? "HEAD");
  if (!target || !repo || !output)
    throw new Error("--release, --repo and --output require a value");
  const published = offline ? null : await publishedReleases();
  const file = flags.path ? readFileSync(resolve(flags.path), "utf8") : null;
  const foreign = file === null ? null : otherHighlightsHeading(file);
  if (foreign) throw new Error(`${flags.path}: highlights are English only, remove "${foreign}"`);
  const given = file === null ? [] : highlightsFromBody(file);
  if (flags.path && given.length === 0)
    throw new Error(`${flags.path} needs ## Highlights (en) with bullets`);
  const version = bareVersion(packageVersionOf(repo, target));
  const history = generateReleaseHistory(
    repo,
    target,
    mergeHighlights(
      committed ? knownHighlights(committed) : null,
      published ? highlightsFromReleases(published) : null,
      given.length > 0 ? { [version]: given } : null,
    ),
  );
  const content = renderReleaseHistory(history);
  if (check) {
    if (readFileSync(output, "utf8") !== content) {
      console.error("release notes are stale — run bun run gen release-notes");
      process.exit(1);
    }
    console.log("release notes are current");
    process.exit(0);
  }
  writeFileSync(output, content);
  console.log(
    `generated ${history.releases.length} released note groups and ${history.unpublished.notes.length} unpublished notes`,
  );
}
