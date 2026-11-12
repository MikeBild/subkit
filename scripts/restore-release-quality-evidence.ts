import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isCanonicalRepoPath } from "../apps/engine/scripts/audit/mutation-wave.ts";
import { readBundleFile } from "./export-shard-quality-evidence.ts";
import { parseQualityBundleIndex, qualityBundleIndexPath } from "./verify-shard-quality-bundle.ts";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const DEFAULT_DESTINATION = "reports/quality-export/shards/quality-bundle.json";

function requireCommit(commit: string): void {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("commit must be a full lowercase SHA-1");
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`${label} must be a real directory`);
  return absolute;
}

function safeDestination(repo: string, path: string): string {
  if (!isCanonicalRepoPath(path)) throw new Error("restore destination path is not canonical");
  const absolute = resolve(repo, path);
  if (relative(repo, absolute) !== path) throw new Error("restore destination escapes repository");
  return absolute;
}

function assertNoSymlinkParents(repo: string, path: string): void {
  let cursor = repo;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`restore destination traverses a symlink: ${path}`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`restore destination has a non-directory ancestor: ${path}`);
  }
}

function verifyCheckout(repo: string, commit: string): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (head !== commit) throw new Error("release checkout does not match commit");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repo });
}

export function restoreReleaseQualityEvidence(options: {
  repo: string;
  source: string;
  commit: string;
  index?: string;
}): string {
  requireCommit(options.commit);
  const repo = realDirectory(options.repo, "repository");
  const source = realDirectory(options.source, "evidence source");
  verifyCheckout(repo, options.commit);
  const destinationIndex = qualityBundleIndexPath(options.index ?? DEFAULT_DESTINATION);
  const sourceIndex = readBundleFile(source, "quality-bundle.json");
  const bundle = parseQualityBundleIndex(
    JSON.parse(new TextDecoder().decode(sourceIndex)),
    options.commit,
  );
  const closure = bundle.files.map((file) => {
    const bytes = readBundleFile(source, file.path);
    if (hash(bytes) !== file.sha256) throw new Error(`bundle file changed: ${file.path}`);
    return { path: file.path, bytes };
  });
  const writes = [...closure, { path: destinationIndex, bytes: sourceIndex }];
  const paths = new Set<string>();
  for (const item of writes) {
    if (!isCanonicalRepoPath(item.path) || paths.has(item.path))
      throw new Error("restore has an invalid or duplicate destination");
    paths.add(item.path);
    const destination = safeDestination(repo, item.path);
    assertNoSymlinkParents(repo, item.path);
    if (!existsSync(destination)) continue;
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`restore destination is not a regular file: ${item.path}`);
    const existing = readFileSync(destination);
    if (!existing.equals(item.bytes))
      throw new Error(`restore destination conflicts: ${item.path}`);
  }
  for (const item of writes) {
    const destination = safeDestination(repo, item.path);
    if (existsSync(destination)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    assertNoSymlinkParents(repo, item.path);
    writeFileSync(destination, item.bytes, { flag: "wx" });
  }
  return destinationIndex;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key))
      throw new Error("invalid restore arguments");
    values.set(key, value);
  }
  const commit = values.get("--commit");
  const source = values.get("--source");
  const index = values.get("--index");
  const repo = values.get("--repo") ?? resolve(import.meta.dir, "..");
  if (
    !commit ||
    !source ||
    values.size < 2 ||
    values.size > 4 ||
    [...values.keys()].some((key) => !["--commit", "--source", "--repo", "--index"].includes(key))
  )
    throw new Error(
      "usage: restore-release-quality-evidence.ts --commit <sha> --source <dir> [--repo <dir>] [--index <canonical path>]",
    );
  console.log(restoreReleaseQualityEvidence({ repo, source, commit, ...(index ? { index } : {}) }));
}
