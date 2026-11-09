import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateMutationValidationTicketEvidence } from "../apps/engine/scripts/audit/mutation-ticket-evidence.ts";
import {
  isCanonicalRepoPath,
  type MutationWaveManifest,
} from "../apps/engine/scripts/audit/mutation-wave.ts";
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

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
};

export function validatePortableParentValidationTicket(
  repo: string,
  index: QualityBundleIndex,
): void {
  const union = record(
    JSON.parse(new TextDecoder().decode(readBundleFile(repo, index.mutation_union_path))),
    "mutation union",
  );
  if (typeof union.run_id !== "string" || union.run_id.length === 0)
    throw new Error("mutation union run id is malformed");
  const wavePath = join(dirname(index.mutation_union_path), "wave.json");
  const waveText = new TextDecoder().decode(readBundleFile(repo, wavePath));
  const parsedWave = JSON.parse(waveText) as MutationWaveManifest;
  const wave = record(parsedWave, "mutation wave");
  if (typeof wave.wave_id !== "string" || wave.wave_id.length === 0)
    throw new Error("mutation wave id is malformed");
  const shards = Array.isArray(wave.shards)
    ? wave.shards.map((shard) => record(shard, "mutation shard"))
    : null;
  if (!shards) throw new Error("mutation wave shards are malformed");
  const receipts = shards.map((shard) => {
    if (typeof shard.id !== "string" || !isCanonicalRepoPath(shard.id))
      throw new Error("mutation shard id is malformed");
    return record(
      JSON.parse(
        new TextDecoder().decode(
          readBundleFile(repo, join(dirname(index.mutation_union_path), shard.id, "receipt.json")),
        ),
      ),
      "mutation receipt",
    );
  });
  const bindings = receipts.map((receipt) => ({
    path: receipt.parent_validation_ticket_path,
    sha256: receipt.parent_validation_ticket_sha256,
  }));
  if (bindings.every(({ path, sha256 }) => path === undefined && sha256 === undefined)) return;
  if (
    bindings.some(
      ({ path, sha256 }) =>
        typeof path !== "string" ||
        !isCanonicalRepoPath(path) ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256),
    )
  )
    throw new Error("bundle has partial parent validation ticket binding");
  const binding = bindings[0]! as { path: string; sha256: string };
  if (bindings.some(({ path, sha256 }) => path !== binding.path || sha256 !== binding.sha256))
    throw new Error("bundle mutation receipts disagree on parent validation ticket binding");
  if (!index.files.some((file) => file.path === binding.path))
    throw new Error("bundle omits parent validation ticket");
  const ticketText = new TextDecoder().decode(readBundleFile(repo, binding.path));
  validateMutationValidationTicketEvidence({
    repo,
    wave: parsedWave,
    waveText,
    runId: union.run_id,
    mutationRoot: dirname(index.mutation_union_path),
    ticketPath: binding.path,
    ticketSha256: binding.sha256,
    ticketText,
  });
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
  validatePortableParentValidationTicket(repo, index);
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
