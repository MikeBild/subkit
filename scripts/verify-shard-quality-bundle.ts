import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isCanonicalRepoPath } from "../apps/engine/scripts/audit/mutation-wave.ts";
import { verifyQualityShards } from "../apps/engine/scripts/verify-quality-shards.ts";
import { readBundleFile } from "./export-shard-quality-evidence.ts";

interface QualityBundleIndex {
  version: 1;
  commit_sha: string;
  acceptance_path: string;
  mutation_union_path: string;
  coverage_union_path: string;
  files: { path: string; sha256: string }[];
}

export const DEFAULT_QUALITY_BUNDLE_INDEX = "quality-bundle.json";

export function qualityBundleIndexPath(indexPath = DEFAULT_QUALITY_BUNDLE_INDEX): string {
  if (!isCanonicalRepoPath(indexPath))
    throw new Error("Quality bundle index path is not canonical");
  return indexPath;
}

export function parseQualityBundleIndex(
  value: unknown,
  expectedCommit: string,
): QualityBundleIndex {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error("Invalid expected release commit");
  if (!value || typeof value !== "object") throw new Error("Malformed quality bundle");
  const index = value as QualityBundleIndex;
  if (index.version !== 1 || index.commit_sha !== expectedCommit || !Array.isArray(index.files))
    throw new Error("Quality bundle does not belong to the release commit");
  const paths = new Set<string>();
  for (const file of index.files) {
    if (
      !file ||
      !isCanonicalRepoPath(file.path) ||
      paths.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid or duplicate bundle file");
    paths.add(file.path);
  }
  for (const path of [index.acceptance_path, index.mutation_union_path, index.coverage_union_path])
    if (!isCanonicalRepoPath(path) || !paths.has(path))
      throw new Error("Bundle omits required quality evidence");
  return index;
}

export async function verifyShardQualityBundle(
  repo: string,
  expectedCommit: string,
  indexPath = DEFAULT_QUALITY_BUNDLE_INDEX,
): Promise<string> {
  const bundleIndexPath = qualityBundleIndexPath(indexPath);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (head !== expectedCommit) throw new Error("Release checkout does not match expected commit");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repo });
  if (!existsSync(join(repo, bundleIndexPath)))
    throw new Error(
      `Release quality bundle is missing at ${bundleIndexPath}. Run \`bun run verify:quality:release-shards\` first.`,
    );
  const index = parseQualityBundleIndex(
    JSON.parse(new TextDecoder().decode(readBundleFile(repo, bundleIndexPath))),
    expectedCommit,
  );
  for (const file of index.files) {
    const actual = createHash("sha256").update(readBundleFile(repo, file.path)).digest("hex");
    if (actual !== file.sha256) throw new Error(`Quality bundle file changed: ${file.path}`);
  }
  const acceptance = JSON.parse(
    new TextDecoder().decode(readBundleFile(repo, index.acceptance_path)),
  ) as { external_runtime_acceptance?: { path?: unknown } };
  const externalRuntimeAcceptancePath = acceptance.external_runtime_acceptance?.path;
  if (
    externalRuntimeAcceptancePath !== undefined &&
    (!isCanonicalRepoPath(externalRuntimeAcceptancePath) ||
      !index.files.some((file) => file.path === externalRuntimeAcceptancePath))
  )
    throw new Error("Bundle omits external runtime acceptance evidence");
  return verifyQualityShards({
    repo,
    requireVersionedPolicy: true,
    mutationUnionPath: join(repo, index.mutation_union_path),
    coverageUnionPath: join(repo, index.coverage_union_path),
    ...(typeof externalRuntimeAcceptancePath === "string" ? { externalRuntimeAcceptancePath } : {}),
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const commitIndex = args.indexOf("--commit");
  const indexIndex = args.indexOf("--index");
  const valid =
    commitIndex !== -1 &&
    typeof args[commitIndex + 1] === "string" &&
    (indexIndex === -1
      ? args.length === 2
      : args.length === 4 && typeof args[indexIndex + 1] === "string");
  if (!valid)
    throw new Error(
      "usage: verify-shard-quality-bundle.ts --commit <sha> [--index <repo-relative-path>]",
    );
  console.log(
    await verifyShardQualityBundle(
      resolve(import.meta.dir, ".."),
      args[commitIndex + 1]!,
      indexIndex === -1 ? undefined : args[indexIndex + 1],
    ),
  );
}
