#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseNotes = {
  version: string;
  notes: string[];
};

export type ReleaseHistory = {
  source: string;
  releases: ReleaseNotes[];
  unpublished: string[];
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
  unpublished: string[];
}): ReleaseHistory {
  return {
    source: input.source,
    releases: input.releases.map(({ version, subjects }) => ({
      version,
      notes: releaseNotesFromSubjects(subjects),
    })),
    unpublished: releaseNotesFromSubjects(input.unpublished),
  };
}

const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function subjects(repo: string, range: string): string[] {
  if (!range) return [];
  return git(repo, ["log", "--no-merges", "--format=%s", range]).split("\n").filter(Boolean);
}

function releaseTags(repo: string, target: string): string[] {
  return git(repo, ["tag", "--merged", target, "--list", "v*.*.*", "--sort=version:refname"])
    .split("\n")
    .filter(Boolean);
}

export function renderReleaseHistory(history: ReleaseHistory): string {
  return `export type ReleaseNotes = { version: string; notes: string[] };\n\nexport const RELEASE_HISTORY: { source: string; releases: ReleaseNotes[]; unpublished: string[] } = ${JSON.stringify(history, null, 2)};\n`;
}

export function generateReleaseHistory(repo: string, target: string): ReleaseHistory {
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
    unpublished: subjects(repo, latest ? `${latest}..${target}` : target),
  });
}

if (import.meta.main) {
  const releaseIndex = process.argv.indexOf("--release");
  const repoIndex = process.argv.indexOf("--repo");
  const outputIndex = process.argv.indexOf("--output");
  const repo = resolve(repoIndex === -1 ? defaultRepo : (process.argv[repoIndex + 1] ?? ""));
  const output = resolve(
    outputIndex === -1
      ? `${repo}/apps/cockpit/src/app/release-notes.generated.ts`
      : (process.argv[outputIndex + 1] ?? ""),
  );
  const check = process.argv.includes("--check");
  const committed = check && releaseIndex === -1;
  const target = committed
    ? ((await import(output)) as { RELEASE_HISTORY: ReleaseHistory }).RELEASE_HISTORY.source
    : releaseIndex === -1
      ? "HEAD"
      : process.argv[releaseIndex + 1];
  if (!target || !repo || !output)
    throw new Error("--release, --repo and --output require a value");
  const history = generateReleaseHistory(repo, target);
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
    `generated ${history.releases.length} released note groups and ${history.unpublished.length} unpublished notes`,
  );
}
