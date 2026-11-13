import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  mutationClosureFiles,
  mutationTestInputs,
  patchedDependencyInputs,
} from "./mutation-inputs.ts";
import { validateRuntimeWitnessLedger } from "./mutation-validation-ticket.ts";
import type { MutationWaveManifest } from "./mutation-wave.ts";
import { digestCanonical, digestWaveFiles, isCanonicalRepoPath } from "./mutation-wave.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const listHash = (values: readonly string[]) => digestCanonical(sorted(values));
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
};
const paths = (value: unknown, label: string): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((path) => typeof path === "string" && isCanonicalRepoPath(path))
  )
    throw new Error(`${label} paths are malformed`);
  return value as string[];
};

export function validateMutationValidationTicketEvidence(input: {
  repo: string;
  wave: MutationWaveManifest;
  waveText: string;
  runId: string;
  mutationRoot: string;
  ticketPath: string;
  ticketSha256: string;
  ticketText: string;
}): void {
  const expectedRoot = join("reports", "mutation", "runs", input.wave.wave_id, input.runId);
  const expectedTicket = join(expectedRoot, "mutation-validation-ticket.json");
  if (
    input.mutationRoot !== expectedRoot ||
    input.ticketPath !== expectedTicket ||
    !SHA256.test(input.ticketSha256) ||
    sha(input.ticketText) !== input.ticketSha256
  )
    throw new Error("parent validation ticket binding differs");
  const ticket = object(JSON.parse(input.ticketText), "parent validation ticket");
  if (
    ticket.version !== 1 ||
    ticket.wave_id !== input.wave.wave_id ||
    ticket.run_id !== input.runId ||
    typeof ticket.original_repo !== "string" ||
    typeof ticket.parent_run_root !== "string" ||
    typeof ticket.manifest_path !== "string" ||
    !isAbsolute(ticket.original_repo) ||
    !isAbsolute(ticket.parent_run_root) ||
    !isAbsolute(ticket.manifest_path) ||
    relative(ticket.original_repo, ticket.parent_run_root) !== expectedRoot ||
    relative(ticket.original_repo, ticket.manifest_path) !== join(expectedRoot, "wave.json")
  )
    throw new Error("parent validation ticket metadata differs");
  if (
    ticket.manifest_sha256 !== sha(input.waveText) ||
    ticket.manifest_semantic_sha256 !== digestCanonical(JSON.parse(input.waveText)) ||
    ticket.source_freeze_sha256 !== input.wave.source_freeze_sha256 ||
    ticket.test_freeze_sha256 !== input.wave.test_freeze_sha256 ||
    ticket.config_sha256 !== input.wave.config_sha256 ||
    ticket.lock_sha256 !== input.wave.lock_sha256 ||
    ticket.equivalence_manifest_sha256 !== input.wave.equivalence_manifest_sha256 ||
    ticket.dynamic_import_ledger_sha256 !== input.wave.dynamic_import_ledger_sha256 ||
    ticket.runtime_artifact_digest_sha256 !== input.wave.runtime_artifact_digest_sha256 ||
    ticket.quality_policy_sha256 !== input.wave.quality_policy_sha256 ||
    ticket.target_digest_sha256 !== input.wave.target_digest_sha256
  )
    throw new Error("parent validation ticket wave binding differs");
  const runtimeInputs = paths(ticket.runtime_inputs, "runtime input");
  const closureFiles = paths(ticket.closure_files, "closure input");
  const testPaths = paths(ticket.test_paths, "test input");
  const expectedTests = sorted(
    input.wave.shards.flatMap((shard) => shard.tests.map((test) => test.path)),
  );
  if (
    JSON.stringify(runtimeInputs) !== JSON.stringify(sorted(mutationTestInputs(input.repo))) ||
    JSON.stringify(closureFiles) !== JSON.stringify(sorted(mutationClosureFiles(input.repo))) ||
    ticket.runtime_input_source_sha256 !== input.wave.source_freeze_sha256 ||
    ticket.runtime_input_paths_sha256 !== listHash(runtimeInputs) ||
    ticket.closure_paths_sha256 !== listHash(closureFiles) ||
    ticket.test_paths_sha256 !== listHash(testPaths) ||
    JSON.stringify(sorted(testPaths)) !== JSON.stringify(expectedTests) ||
    digestWaveFiles(input.repo, runtimeInputs) !== ticket.runtime_input_source_sha256 ||
    digestWaveFiles(input.repo, closureFiles) !== ticket.closure_source_sha256 ||
    digestWaveFiles(input.repo, testPaths) !== ticket.test_freeze_sha256 ||
    digestWaveFiles(input.repo, ["stryker.config.json"]) !== ticket.config_sha256 ||
    digestWaveFiles(input.repo, ["bun.lock"]) !== ticket.lock_sha256 ||
    digestWaveFiles(input.repo, [input.wave.equivalence_manifest_path]) !==
      ticket.equivalence_manifest_sha256 ||
    digestWaveFiles(input.repo, [input.wave.dynamic_import_ledger_path]) !==
      ticket.dynamic_import_ledger_sha256
  )
    throw new Error("parent validation ticket current source freeze differs");
  if (
    input.wave.quality_policy_sha256 !== undefined &&
    digestWaveFiles(input.repo, ["apps/engine/.quality-shard-policy.json"]) !==
      input.wave.quality_policy_sha256
  )
    throw new Error("parent validation ticket quality policy differs");
  validateRuntimeWitnessLedger({
    repo: input.repo,
    files: closureFiles,
    ledgerPath: input.wave.dynamic_import_ledger_path,
  });
  const patch = Array.isArray(ticket.patch_inputs) ? ticket.patch_inputs : null;
  if (
    !patch?.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string" &&
        isCanonicalRepoPath((entry as { path: string }).path) &&
        typeof (entry as { sha256?: unknown }).sha256 === "string" &&
        SHA256.test((entry as { sha256: string }).sha256),
    )
  )
    throw new Error("parent validation ticket patch inputs are malformed");
  const patchInputs = patch as Array<{ path: string; sha256: string }>;
  if (
    JSON.stringify(patchInputs.map((entry) => entry.path)) !==
      JSON.stringify(
        sorted(["package.json", "bun.lock", ...patchedDependencyInputs(input.repo)]),
      ) ||
    ticket.patch_provenance_sha256 !==
      digestCanonical(patchInputs.map((entry) => [entry.path, entry.sha256])) ||
    patchInputs.some((entry) => sha(readFileSync(join(input.repo, entry.path))) !== entry.sha256)
  )
    throw new Error("parent validation ticket patch provenance differs");
  const targetPaths = input.wave.shards.flatMap((shard) => shard.targets).sort();
  const expectedShards = input.wave.shards.map(
    ({ id, targets, tests, consumers, resource_tags }) => ({
      id,
      targets: [...targets],
      tests,
      consumers,
      resource_tags: [...resource_tags],
    }),
  );
  const ownership = expectedShards.flatMap((shard) =>
    shard.targets.map((target) => [target, shard.id]),
  );
  if (
    !Array.isArray(ticket.target_inventory) ||
    ticket.target_inventory_sha256 !== digestCanonical(ticket.target_inventory) ||
    digestCanonical(
      ticket.target_inventory.map((entry: { path?: unknown }) => entry.path).sort(),
    ) !== digestCanonical(targetPaths) ||
    !Array.isArray(ticket.shards) ||
    ticket.closure_sha256 !== digestCanonical(ticket.shards) ||
    ticket.ownership_sha256 !== digestCanonical(ownership) ||
    digestCanonical(ticket.shards) !== digestCanonical(expectedShards)
  )
    throw new Error("parent validation ticket inventory differs");
}
