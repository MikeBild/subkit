import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { readPublishedCoverage } from "../apps/engine/scripts/audit/coverage-publication.ts";
import { isCanonicalRepoPath } from "../apps/engine/scripts/audit/mutation-wave.ts";
import { exportCoverageEvidence } from "./export-quality-evidence.ts";
import {
  parseQualityBundleIndex,
  verifyShardQualityBundle,
} from "./verify-shard-quality-bundle.ts";

type FileEntry = { path: string; sha256: string };
interface ReleaseEvidenceIndex {
  version: 1;
  commit_sha: string;
  github_run_id: string;
  coverage_run_id: string;
  coverage_receipt_sha256: string;
  shard_bundle_sha256: string;
  archive: { path: string; sha256: string };
  payload: FileEntry[];
}

const hash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function requireCommit(commit: string): void {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("commit must be a full lowercase SHA-1");
}

function requireRunId(runId: string): void {
  if (!/^\d+$/.test(runId)) throw new Error("run-id must be numeric");
}

function safePath(path: string): void {
  if (!isCanonicalRepoPath(path)) throw new Error(`unsafe evidence path: ${path}`);
}

function readRegular(root: string, path: string): Uint8Array {
  safePath(path);
  const absolute = resolve(root, path);
  if (relative(root, absolute) !== path) throw new Error(`evidence escapes root: ${path}`);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`evidence symlink is forbidden: ${path}`);
  }
  if (!lstatSync(absolute).isFile()) throw new Error(`evidence is not a regular file: ${path}`);
  return readFileSync(absolute);
}

function collectFiles(root: string, prefix = ""): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const name of readdirSync(root).sort()) {
    const local = prefix ? `${prefix}/${name}` : name;
    const absolute = join(root, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`evidence symlink is forbidden: ${local}`);
    if (stat.isDirectory()) entries.push(...collectFiles(absolute, local));
    else if (stat.isFile()) entries.push({ path: local, sha256: hash(readFileSync(absolute)) });
    else throw new Error(`unsupported evidence entry: ${local}`);
  }
  return entries;
}

function writeTar(archive: string, payload: string): void {
  execFileSync("tar", ["-C", payload, "-czf", archive, "."], { stdio: "pipe" });
}

function archiveEntries(archive: string): string[] {
  const output = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  return output
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function assertArchiveMemberTypes(archive: string): void {
  const output = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" });
  for (const line of output.split("\n")) {
    if (!line) continue;
    const type = line[0];
    if (type !== "-" && type !== "d")
      throw new Error(`archive contains unsafe member type: ${type ?? "unknown"}`);
  }
}

function extractArchive(archive: string): string {
  const output = mkdtempSync(join(tmpdir(), "subkit-release-evidence-"));
  try {
    assertArchiveMemberTypes(archive);
    const entries = archiveEntries(archive);
    if (entries.some((entry) => !isCanonicalRepoPath(entry)))
      throw new Error("archive contains an unsafe path");
    execFileSync("tar", ["-xzf", archive, "-C", output], { stdio: "pipe" });
    return output;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function parseIndex(path: string, commit: string): ReleaseEvidenceIndex {
  const value = JSON.parse(readFileSync(path, "utf8")) as ReleaseEvidenceIndex;
  if (
    value.version !== 1 ||
    value.commit_sha !== commit ||
    typeof value.github_run_id !== "string" ||
    !/^\d+$/.test(value.github_run_id) ||
    !/^[a-z0-9-]{10,200}$/.test(value.coverage_run_id) ||
    !/^[a-f0-9]{64}$/.test(value.coverage_receipt_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.shard_bundle_sha256) ||
    !value.archive ||
    value.archive.path !== "quality-evidence.tar.gz" ||
    !/^[a-f0-9]{64}$/.test(value.archive.sha256) ||
    !Array.isArray(value.payload)
  )
    throw new Error("release quality evidence index is malformed or belongs to another commit");
  const seen = new Set<string>();
  for (const file of value.payload) {
    if (
      !file ||
      !isCanonicalRepoPath(file.path) ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("release quality evidence payload is malformed");
    seen.add(file.path);
  }
  for (const required of ["coverage/latest.json", "shards/quality-bundle.json"])
    if (!seen.has(required)) throw new Error(`release quality evidence omits ${required}`);
  return value;
}

export async function packageReleaseQualityEvidence(options: {
  repo: string;
  commit: string;
  runId: string;
  coverageDir: string;
  shardIndex: string;
  assetsDir: string;
}): Promise<{ archive: string; index: string }> {
  requireCommit(options.commit);
  requireRunId(options.runId);
  const repo = resolve(options.repo);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (head !== options.commit) throw new Error("release checkout does not match commit");
  const assets = resolve(options.assetsDir);
  if (existsSync(assets)) {
    const stat = lstatSync(assets);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("assets directory must be a real directory");
  } else mkdirSync(assets, { recursive: true });
  for (const name of ["quality-evidence.tar.gz", "quality-evidence.json"])
    if (existsSync(join(assets, name)))
      throw new Error(`release quality evidence already exists: ${name}`);
  const shardIndex = resolve(repo, options.shardIndex);
  const relativeShardIndex = relative(repo, shardIndex);
  safePath(relativeShardIndex);
  await verifyShardQualityBundle(repo, options.commit, relativeShardIndex);
  const staging = mkdtempSync(join(dirname(assets), ".release-quality-evidence-"));
  let archiveLinked = false;
  let indexLinked = false;
  try {
    const payload = join(staging, "payload");
    mkdirSync(payload);
    const coverageSource = resolve(repo, options.coverageDir);
    const selectedCoverage = readPublishedCoverage(coverageSource);
    exportCoverageEvidence(coverageSource, join(payload, "coverage"));
    const bundle = parseQualityBundleIndex(
      JSON.parse(readFileSync(shardIndex, "utf8")),
      options.commit,
    );
    const shardBundleBytes = readRegular(repo, relativeShardIndex);
    const shardRoot = join(payload, "shards");
    mkdirSync(shardRoot);
    writeFileSync(join(shardRoot, "quality-bundle.json"), shardBundleBytes, {
      flag: "wx",
    });
    for (const file of bundle.files) {
      const source = readRegular(repo, file.path);
      if (hash(source) !== file.sha256) throw new Error(`shard evidence changed: ${file.path}`);
      const destination = join(shardRoot, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source, { flag: "wx" });
    }
    const payloadFiles = collectFiles(payload);
    const archive = join(staging, "quality-evidence.tar.gz");
    writeTar(archive, payload);
    const index: ReleaseEvidenceIndex = {
      version: 1,
      commit_sha: options.commit,
      github_run_id: options.runId,
      coverage_run_id: selectedCoverage.runId,
      coverage_receipt_sha256: hash(readFileSync(selectedCoverage.receiptPath)),
      shard_bundle_sha256: hash(shardBundleBytes),
      archive: { path: "quality-evidence.tar.gz", sha256: hash(readFileSync(archive)) },
      payload: payloadFiles,
    };
    writeFileSync(join(staging, "quality-evidence.json"), `${JSON.stringify(index, null, 2)}\n`, {
      flag: "wx",
    });
    linkSync(archive, join(assets, "quality-evidence.tar.gz"));
    archiveLinked = true;
    linkSync(join(staging, "quality-evidence.json"), join(assets, "quality-evidence.json"));
    indexLinked = true;
    rmSync(staging, { recursive: true, force: true });
    return {
      archive: join(assets, "quality-evidence.tar.gz"),
      index: join(assets, "quality-evidence.json"),
    };
  } catch (error) {
    if (indexLinked) rmSync(join(assets, "quality-evidence.json"), { force: true });
    if (archiveLinked) rmSync(join(assets, "quality-evidence.tar.gz"), { force: true });
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyReleaseQualityEvidence(options: {
  commit: string;
  assetsDir: string;
}): ReleaseEvidenceIndex {
  requireCommit(options.commit);
  const assets = resolve(options.assetsDir);
  if (lstatSync(assets).isSymbolicLink() || !lstatSync(assets).isDirectory())
    throw new Error("assets directory must be a real directory");
  const index = parseIndex(join(assets, "quality-evidence.json"), options.commit);
  const archive = join(assets, index.archive.path);
  if (hash(readRegular(assets, index.archive.path)) !== index.archive.sha256)
    throw new Error("release quality evidence archive changed");
  const extracted = extractArchive(archive);
  try {
    const actual = collectFiles(extracted);
    if (JSON.stringify(actual) !== JSON.stringify(index.payload))
      throw new Error("release quality evidence archive payload differs from index");
    for (const file of index.payload)
      if (hash(readRegular(extracted, file.path)) !== file.sha256)
        throw new Error(`release quality evidence payload changed: ${file.path}`);
    const coverage = readPublishedCoverage(join(extracted, "coverage"));
    if (
      coverage.runId !== index.coverage_run_id ||
      hash(readFileSync(coverage.receiptPath)) !== index.coverage_receipt_sha256
    )
      throw new Error("release quality evidence coverage binding changed");
    const shardIndex = readRegular(extracted, "shards/quality-bundle.json");
    if (hash(shardIndex) !== index.shard_bundle_sha256)
      throw new Error("release quality evidence shard bundle binding changed");
    parseQualityBundleIndex(JSON.parse(new TextDecoder().decode(shardIndex)), options.commit);
    return index;
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

function optionsFromArgs(args: string[]): {
  command: "package" | "verify";
  values: Map<string, string>;
} {
  const command = args[0];
  if (command !== "package" && command !== "verify")
    throw new Error("usage: release-quality-evidence.ts package|verify ...");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key))
      throw new Error("invalid release quality evidence arguments");
    values.set(key, value);
  }
  return { command, values };
}

if (import.meta.main) {
  const { command, values } = optionsFromArgs(process.argv.slice(2));
  const commit = values.get("--commit");
  const assetsDir = values.get("--assets-dir");
  if (!commit || !assetsDir) throw new Error("--commit and --assets-dir are required");
  if (command === "verify") {
    if (values.size !== 2) throw new Error("verify accepts only --commit and --assets-dir");
    console.log(JSON.stringify(verifyReleaseQualityEvidence({ commit, assetsDir })));
  } else {
    const runId = values.get("--run-id"),
      coverageDir = values.get("--coverage-dir"),
      shardIndex = values.get("--shard-index");
    if (!runId || !coverageDir || !shardIndex || values.size !== 5)
      throw new Error(
        "package requires --commit --run-id --coverage-dir --shard-index --assets-dir",
      );
    console.log(
      JSON.stringify(
        await packageReleaseQualityEvidence({
          repo: resolve(import.meta.dir, ".."),
          commit,
          runId,
          coverageDir,
          shardIndex,
          assetsDir,
        }),
      ),
    );
  }
}
