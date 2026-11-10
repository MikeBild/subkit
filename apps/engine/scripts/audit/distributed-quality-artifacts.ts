import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface DistributedArtifactIdentity {
  commit: string;
  githubRunId: string;
  ticketSha256: string;
}
interface DistributedArtifactManifest {
  version: 1;
  identity: DistributedArtifactIdentity;
  files: Array<{ path: string; sha256: string }>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const allowed = (path: string) =>
  (path.startsWith("reports/") || path.startsWith(".artifacts/")) &&
  !path.startsWith("reports/distributed-quality/");
const canonical = (path: string) =>
  typeof path === "string" &&
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.split("/").some((part) => !part || part === "." || part === "..");
const sameIdentity = (left: DistributedArtifactIdentity, right: DistributedArtifactIdentity) =>
  left.commit === right.commit &&
  left.githubRunId === right.githubRunId &&
  left.ticketSha256 === right.ticketSha256;

function regularUnder(root: string, path: string): string {
  if (!canonical(path) || !allowed(path)) throw new Error("Artifact path is not allowed");
  const absolute = resolve(root, path);
  if (relative(root, absolute) !== path) throw new Error("Artifact path escapes repository");
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Artifact symlink is forbidden");
  }
  if (!lstatSync(absolute).isFile()) throw new Error("Artifact must be a regular file");
  return absolute;
}

function restorePathUnder(root: string, path: string): string {
  if (!canonical(path) || !allowed(path)) throw new Error("Artifact restore path is not allowed");
  const target = resolve(root, path);
  if (relative(root, target) !== path) throw new Error("Artifact restore escapes repository");
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error("Artifact restore symlink is forbidden");
  }
  return target;
}

function parseManifest(
  source: string,
  expected: DistributedArtifactIdentity,
): DistributedArtifactManifest {
  const manifest = JSON.parse(
    readFileSync(join(source, "quality-artifacts.json"), "utf8"),
  ) as DistributedArtifactManifest;
  if (
    manifest.version !== 1 ||
    !manifest.identity ||
    !sameIdentity(manifest.identity, expected) ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Artifact package has foreign identity");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      !canonical(file.path) ||
      !allowed(file.path) ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Artifact package manifest is malformed");
    seen.add(file.path);
  }
  return manifest;
}

export function packQualityArtifacts(options: {
  repo: string;
  destination: string;
  files: readonly string[];
  identity: DistributedArtifactIdentity;
}): string {
  const repo = resolve(options.repo),
    destination = resolve(options.destination);
  if (existsSync(destination)) throw new Error("Artifact package destination already exists");
  const seen = new Set<string>();
  const files = options.files.map((path) => {
    if (seen.has(path)) throw new Error("Artifact package has duplicate paths");
    seen.add(path);
    const bytes = readFileSync(regularUnder(repo, path));
    return { path, bytes, sha256: hash(bytes) };
  });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(destination, "files", file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.bytes, { flag: "wx", mode: 0o600 });
  }
  const manifest: DistributedArtifactManifest = {
    version: 1,
    identity: options.identity,
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  };
  const output = join(destination, "quality-artifacts.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return output;
}

export function restoreQualityArtifacts(options: {
  repo: string;
  source: string;
  expectedIdentity: DistributedArtifactIdentity;
}): string[] {
  const repo = resolve(options.repo),
    source = resolve(options.source);
  const manifest = parseManifest(source, options.expectedIdentity);
  const prepared = manifest.files.map((file) => {
    const sourcePath = join(source, "files", file.path);
    const bytes = readFileSync(regularUnder(join(source, "files"), file.path));
    if (hash(bytes) !== file.sha256) throw new Error("Artifact package hash differs");
    const target = restorePathUnder(repo, file.path);
    return { ...file, sourcePath, bytes, target };
  });
  for (const file of prepared)
    if (
      existsSync(file.target) &&
      hash(readFileSync(regularUnder(repo, file.path))) !== file.sha256
    )
      throw new Error("Artifact restore conflicts with existing file");
  for (const file of prepared) {
    if (existsSync(file.target)) continue;
    mkdirSync(dirname(file.target), { recursive: true, mode: 0o700 });
    writeFileSync(file.target, file.bytes, { flag: "wx", mode: 0o600 });
  }
  return prepared.map((file) => file.target);
}
