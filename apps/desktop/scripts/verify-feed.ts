import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ArtifactFacts,
  feedProblems,
  RELEASE_FEEDS,
  readFeed,
} from "../src/shared/release-feed.ts";

const [directory, version, ...rest] = process.argv.slice(2);
if (!directory || !version)
  throw new Error("usage: bun run scripts/verify-feed.ts <directory> <version> [feed ...]");
const feeds = rest.length ? rest : [...RELEASE_FEEDS];
const root = resolve(directory);

const artifacts = new Map<string, ArtifactFacts>();
for (const name of await readdir(root)) {
  const path = join(root, name);
  const facts = await stat(path);
  if (!facts.isFile()) continue;
  artifacts.set(name, {
    sha512: createHash("sha512")
      .update(await readFile(path))
      .digest("base64"),
    size: facts.size,
  });
}

const problems: string[] = [];
for (const name of feeds) {
  if (!artifacts.has(name)) {
    problems.push(`${name} is missing`);
    continue;
  }
  const feed = readFeed(Bun.YAML.parse(await readFile(join(root, name), "utf8")));
  if (!feed) {
    problems.push(`${name} is not an update feed`);
    continue;
  }
  for (const problem of feedProblems(feed, version, artifacts)) problems.push(`${name} ${problem}`);
}
if (problems.length) throw new Error(`Update feed check failed:\n${problems.join("\n")}`);
console.log(`${feeds.join(", ")} match the artifacts of ${version} in ${root}`);
