#!/usr/bin/env bun
//
// Bump the release version — and everything the version is baked into.
//
//   bun run bump 5.10.0
//
// The root `package.json` version is not the only place a release number
// lives: `gen-openapi-client.ts` copies it into the committed
// `packages/cli-core/src/engine-api/openapi.json` so the checked-in contract
// names the release rather than whatever a running binary reports. Editing
// package.json alone therefore leaves the repo in a state where
// `check:openapi-drift` fails — and it fails at `git push`, after the commit
// is already written, which is the worst possible moment to discover it.
//
// This script makes the bump atomic in the only sense that matters: when it
// exits 0, every artifact derived from the version has been regenerated in the
// working tree, so the commit that follows carries them. Note that
// `check:openapi-drift` compares the generated output against the COMMITTED
// artifact — between this script and your commit it is red by construction,
// and green immediately after. Nothing here talks to a network or a deploy
// target.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(REPO, "package.json");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function die(message: string): never {
  console.error(`bump: ${message}`);
  process.exit(1);
}

function parseVersion(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) die(`not a plain semver version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `next` sorts strictly after `current`. */
function isAscending(current: string, next: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(next);
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

function tagExists(tag: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
      cwd: REPO,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

const next = process.argv[2];
if (!next) die("usage: bun run bump <version>   (e.g. 5.10.0)");

const pkgText = readFileSync(PKG, "utf8");
const pkg = JSON.parse(pkgText) as { version: string };
const current = pkg.version;

parseVersion(next);
if (next === current) die(`already at ${current} — a released tag must never be reused`);
if (!isAscending(current, next)) die(`${next} does not sort after the current ${current}`);
if (tagExists(`v${next}`)) die(`tag v${next} already exists — pick the next unused version`);

// Rewrite only the top-level "version" key, preserving byte-for-byte
// formatting everywhere else. A JSON round-trip would reformat the whole file
// and bury the one-line change in noise.
const replaced = pkgText.replace(
  new RegExp(`("version":\\s*")${current.replace(/\./g, "\\.")}(")`),
  `$1${next}$2`,
);
if (replaced === pkgText) die(`could not locate "version": "${current}" in package.json`);
writeFileSync(PKG, replaced);
console.log(`bump: package.json ${current} → ${next}`);

// Regenerate every artifact the version is copied into. Today that is the
// OpenAPI contract; if another generator starts embedding the version, add it
// here rather than to a release checklist a human has to remember.

// docker-compose.yml pins the engine image, and since 6.23.0 every running
// engine SERVES that file at GET /docker-compose.yml. A stale tag there is not
// a cosmetic lag: it hands a newcomer the topology of the previous release
// while claiming to describe this one. The bump owns it for the same reason it
// owns the OpenAPI artifact — a release checklist is not a mechanism.
{
  const composePath = join(REPO, "docker-compose.yml");
  const compose = readFileSync(composePath, "utf8");
  const pinned = /\$\{SUBKIT_IMAGE_TAG:-(\d+\.\d+\.\d+)\}/.exec(compose);
  if (!pinned) {
    die("docker-compose.yml no longer pins ${SUBKIT_IMAGE_TAG:-<version>} — update this script");
  }
  if (pinned[1] !== next) {
    writeFileSync(
      composePath,
      compose.replace(/\$\{SUBKIT_IMAGE_TAG:-\d+\.\d+\.\d+\}/, `\${SUBKIT_IMAGE_TAG:-${next}}`),
    );
    console.log(`bump: docker-compose.yml image tag ${pinned[1]} → ${next}`);
  } else {
    console.log("bump: docker-compose.yml image tag already matched");
  }
}

console.log("bump: regenerating the OpenAPI client …");
execFileSync("bun", ["run", "gen:openapi-client"], { cwd: REPO, stdio: "inherit" });

// Prove it rather than assume it — this is the exact check that runs on push.
try {
  execFileSync("git", ["diff", "--exit-code", "packages/cli-core/src/engine-api"], {
    cwd: REPO,
    stdio: "pipe",
  });
  console.log("bump: OpenAPI artifact already matched (nothing to regenerate)");
} catch {
  console.log("bump: OpenAPI artifact updated");
}

console.log(`\nbump: at ${next}. Commit the change, then: bun run release:tag`);
