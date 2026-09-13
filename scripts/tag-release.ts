#!/usr/bin/env bun
//
// Cut the release tag — or refuse, with the reason.
//
//   bun run release:tag
//
// A release tag is the input to the build AND to the deploy that follows it.
// Pushing one that points somewhere unintended is not a mistake you notice
// quickly: the build succeeds, the release publishes, and the artifact simply
// contains something other than what is on `main`.
//
// The failure this exists to prevent, observed while cutting v5.9.0: a tag was
// created, the branch was then rebased onto an upstream commit that had landed
// meanwhile, and the tag stayed behind on the pre-rebase commit — which was no
// longer reachable from `main` at all. `git push origin <tag>` would have
// happily shipped it.
//
// Every precondition below is checked against the REMOTE, because that is what
// the build actually checks out. On success it pushes exactly one ref: the tag.
// Never `--tags` — a push carrying several tags at once makes GitHub skip the
// workflow triggers entirely.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseVersionWasUsed } from "./release-history.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

const problems: string[] = [];
function require_(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

const version = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;
const tag = `v${version}`;

console.log(`release:tag: preparing ${tag}\n`);

// The remote is the source of truth for what will be built. Fetch before
// comparing, or every check below is answered from a stale view.
git("fetch", "origin", "--tags", "--quiet");

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const head = git("rev-parse", "HEAD");
const originMain = git("rev-parse", "origin/main");
const dirty = git("status", "--porcelain");

require_(branch === "main", `on branch '${branch}' — releases are cut from main`);
require_(dirty === "", `working tree is dirty:\n${dirty}`);
require_(
  head === originMain,
  `HEAD (${head.slice(0, 8)}) is not origin/main (${originMain.slice(0, 8)}) — push or pull first`,
);

// A tag that already exists anywhere is never silently moved. Reusing a
// released version is the one thing a release process must make impossible.
const localTag = (() => {
  try {
    return git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
  } catch {
    return "";
  }
})();
const remoteTag = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`);

require_(remoteTag === "", `${tag} already exists on origin — bump to the next version`);

// Tags and Releases are mutable in GitHub even though release identities must
// not be. A previously published tag can therefore disappear while its
// workflow run remains in Actions history. That happened with v6.7.0: the tag
// and Release had been deleted, so the old tag-only guard allowed the version
// to be reused. Treat every previous release workflow run — including failed
// and cancelled attempts — as an immutable claim on the version.
try {
  const releaseRuns = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "release.yml",
      "--branch",
      tag,
      "--limit",
      "1",
      "--json",
      "databaseId",
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  require_(
    !releaseVersionWasUsed(releaseRuns),
    `${tag} already appears in release workflow history — versions are never reused`,
  );
} catch (err) {
  problems.push(
    `cannot verify immutable release history for ${tag}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
if (localTag !== "") {
  // The v5.9.0 case: a leftover local tag pointing at a commit the rebase
  // orphaned. Deleting it silently would hide exactly the mistake worth
  // seeing, so say where it points and let a human decide.
  require_(
    localTag === head,
    `${tag} exists locally at ${localTag.slice(0, 8)} but HEAD is ${head.slice(0, 8)} ` +
      `— it was most likely created before a rebase. Delete it (git tag -d ${tag}) and re-run.`,
  );
}

if (problems.length > 0) {
  console.error("release:tag: refusing to tag —\n");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

if (localTag === "") git("tag", tag, head);
console.log(`release:tag: ${tag} → ${head.slice(0, 8)}`);

// One ref, explicitly named. A tag push is what triggers release.yml.
execFileSync("git", ["push", "origin", `refs/tags/${tag}`], { cwd: REPO, stdio: "inherit" });
console.log(`\nrelease:tag: pushed ${tag}. Verify the deployed engine with:`);
console.log(`  bun run verify:release -- --engine-url <url> --version ${version}`);
