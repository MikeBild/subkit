#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liveGateFailureHint } from "./llm-live-checks.ts";
import { assertReleaseRefsUnchanged, releaseGateContext } from "./release-gate-provenance.ts";
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

function readLocalTag(): string {
  try {
    return git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return "";
    throw error;
  }
}
const localTag = readLocalTag();
const remoteTag = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`);

require_(remoteTag === "", `${tag} already exists on origin — bump to the next version`);

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

console.log("release:tag: running the live LLM gate (bun run verify:llm-live)\n");
try {
  execFileSync("bun", ["run", "verify:llm-live", "--", ...process.argv.slice(2)], {
    cwd: REPO,
    stdio: "inherit",
  });
} catch {
  console.error(liveGateFailureHint(tag));
  process.exit(1);
}

console.log("release:tag: running the release gate (bun run verify:gate)\n");
try {
  execFileSync("bun", ["run", "verify:gate"], { cwd: REPO, stdio: "inherit" });
} catch {
  console.error(`release:tag: refusing to tag ${tag} — bun run verify:gate failed`);
  process.exit(1);
}

if (
  git("rev-parse", "HEAD") !== head ||
  git("status", "--porcelain") !== "" ||
  git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0] !== head
) {
  throw new Error("Release source changed during verification; refusing to publish gate status");
}
assertReleaseRefsUnchanged(
  localTag,
  readLocalTag(),
  git("ls-remote", "--tags", "origin", `refs/tags/${tag}`),
  head,
);
execFileSync(
  "gh",
  [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/statuses/${head}`,
    "-f",
    "state=success",
    "-f",
    `context=${releaseGateContext(tag)}`,
    "-f",
    "description=Mandatory local verification and live models passed",
    "--silent",
  ],
  { cwd: REPO, stdio: "inherit" },
);

assertReleaseRefsUnchanged(
  localTag,
  readLocalTag(),
  git("ls-remote", "--tags", "origin", `refs/tags/${tag}`),
  head,
);
if (localTag === "") git("tag", tag, head);
if (readLocalTag() !== head) throw new Error("Release tag no longer points to the verified commit");
console.log(`release:tag: ${tag} → ${head.slice(0, 8)}`);

const pushed = execFileSync("git", ["push", "--porcelain", "origin", `${head}:refs/tags/${tag}`], {
  cwd: REPO,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
process.stdout.write(pushed);
if (!pushed.split("\n").some((line) => line.startsWith("*\t") && line.endsWith("[new tag]")))
  throw new Error("Release tag was not newly created on origin; refusing version reuse");
console.log(`\nrelease:tag: pushed ${tag}. Verify the deployed engine with:`);
console.log(`  bun run verify:release -- --engine-url <url> --version ${version}`);
