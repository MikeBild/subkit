#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(REPO, "package.json");
const DESKTOP_PKG = join(REPO, "apps/desktop/package.json");

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
if (!next) die("usage: bun run release bump <version>   (e.g. 5.10.0)");

const pkgText = readFileSync(PKG, "utf8");
const pkg = JSON.parse(pkgText) as { version: string };
const current = pkg.version;

parseVersion(next);
if (next === current) die(`already at ${current} — a released tag must never be reused`);
if (!isAscending(current, next)) die(`${next} does not sort after the current ${current}`);
if (tagExists(`v${next}`)) die(`tag v${next} already exists — pick the next unused version`);

const replaced = pkgText.replace(
  new RegExp(`("version":\\s*")${current.replace(/\./g, "\\.")}(")`),
  `$1${next}$2`,
);
if (replaced === pkgText) die(`could not locate "version": "${current}" in package.json`);
writeFileSync(PKG, replaced);
console.log(`bump: package.json ${current} → ${next}`);

{
  const desktopText = readFileSync(DESKTOP_PKG, "utf8");
  const desktop = (JSON.parse(desktopText) as { version: string }).version;
  parseVersion(desktop);
  const desktopReplaced = desktopText.replace(
    new RegExp(`("version":\\s*")${desktop.replace(/\./g, "\\.")}(")`),
    `$1${next}$2`,
  );
  if (desktop !== next && desktopReplaced === desktopText)
    die(`could not locate "version": "${desktop}" in apps/desktop/package.json`);
  writeFileSync(DESKTOP_PKG, desktopReplaced);
  console.log(`bump: apps/desktop/package.json ${desktop} → ${next}`);
}

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
execFileSync("bun", ["run", "gen", "openapi"], { cwd: REPO, stdio: "inherit" });

try {
  execFileSync("git", ["diff", "--exit-code", "packages/cli-core/src/engine-api"], {
    cwd: REPO,
    stdio: "pipe",
  });
  console.log("bump: OpenAPI artifact already matched (nothing to regenerate)");
} catch {
  console.log("bump: OpenAPI artifact updated");
}

console.log("bump: rendering the version into the docs and the Web Clipper …");
execFileSync("bun", ["run", "gen", "llms"], { cwd: REPO, stdio: "inherit" });
execFileSync("bun", ["run", "build", "clipper"], { cwd: REPO, stdio: "inherit" });

console.log(`\nbump: at ${next}. Commit the change, then: bun run release tag`);
