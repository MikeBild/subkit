#!/usr/bin/env bun

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

const localTag = (() => {
  try {
    return git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`);
  } catch {
    return "";
  }
})();
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

console.log("release:tag: running the full local gate (bun run verify)\n");
try {
  execFileSync("bun", ["run", "verify"], { cwd: REPO, stdio: "inherit" });
} catch {
  console.error(`release:tag: refusing to tag ${tag} — bun run verify failed`);
  process.exit(1);
}

if (localTag === "") git("tag", tag, head);
console.log(`release:tag: ${tag} → ${head.slice(0, 8)}`);

execFileSync("git", ["push", "origin", `refs/tags/${tag}`], { cwd: REPO, stdio: "inherit" });
console.log(`\nrelease:tag: pushed ${tag}. Verify the deployed engine with:`);
console.log(`  bun run verify:release -- --engine-url <url> --version ${version}`);
