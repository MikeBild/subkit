import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readPublishedCoverage } from "../apps/engine/scripts/audit/coverage-artifacts.ts";
import {
  isCanonicalRepoPath,
  type MutationWaveManifest,
} from "../apps/engine/scripts/audit/mutation-wave.ts";
import { verifyQualityShards } from "../apps/engine/scripts/verify-quality-shards.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function readBundleFile(repo: string, path: string): Uint8Array {
  if (!isCanonicalRepoPath(path)) throw new Error("Noncanonical evidence path");
  const root = resolve(repo);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("Evidence repository must be a real directory");
  const target = resolve(root, path);
  if (relative(root, target) !== path) throw new Error("Evidence escapes repository");
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Evidence symlink is forbidden");
  }
  if (!lstatSync(cursor).isFile()) throw new Error("Evidence must be a regular file");
  return readFileSync(cursor);
}

export async function exportShardQualityEvidence(options: {
  repo: string;
  mutationUnionPath: string;
  coverageUnionPath: string;
  externalRuntimeAcceptancePath?: string;
  destination: string;
}): Promise<string> {
  const repo = resolve(options.repo);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid release commit");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repo });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (untracked.trim()) throw new Error("Release evidence requires a clean checkout");
  const acceptance = await verifyQualityShards({ ...options, requireVersionedPolicy: true });
  const selected = new Set<string>();
  const add = (absolute: string) => {
    const local = relative(repo, resolve(absolute));
    if (!isCanonicalRepoPath(local)) throw new Error("Evidence escapes repository");
    selected.add(local);
  };
  const mutationRoot = dirname(options.mutationUnionPath);
  const coverageRoot = dirname(options.coverageUnionPath);
  const wave = JSON.parse(
    readFileSync(join(mutationRoot, "wave.json"), "utf8"),
  ) as MutationWaveManifest;
  const mutationReceipts = wave.shards.map(
    (shard) =>
      JSON.parse(readFileSync(join(mutationRoot, shard.id, "receipt.json"), "utf8")) as {
        parent_validation_ticket_path?: unknown;
        parent_validation_ticket_sha256?: unknown;
      },
  );
  const parentTicketPaths = new Set(
    mutationReceipts.flatMap((receipt) =>
      typeof receipt.parent_validation_ticket_path === "string"
        ? [receipt.parent_validation_ticket_path]
        : [],
    ),
  );
  const distributedTicket = mutationReceipts.some(
    (receipt) => typeof (receipt as Record<string, unknown>).distributed_ticket_sha256 === "string",
  );
  if (!distributedTicket && parentTicketPaths.size > 1)
    throw new Error("Mutation receipts disagree on parent ticket path");
  for (const path of [
    acceptance,
    options.mutationUnionPath,
    options.coverageUnionPath,
    join(mutationRoot, "wave.json"),
    join(coverageRoot, "wave.json"),
    join(repo, wave.dynamic_import_ledger_path),
    join(repo, wave.equivalence_manifest_path),
    join(repo, "apps/engine/.quality-shard-policy.json"),
    ...(options.externalRuntimeAcceptancePath
      ? [join(repo, options.externalRuntimeAcceptancePath)]
      : []),
  ])
    add(path);
  if (distributedTicket) add(join(repo, "reports/quality-inputs/distributed/ticket.json"));
  else for (const path of parentTicketPaths) add(join(repo, path));
  if (options.externalRuntimeAcceptancePath) {
    const external = JSON.parse(
      new TextDecoder().decode(readBundleFile(repo, options.externalRuntimeAcceptancePath)),
    ) as { commands?: Array<{ build_index_path?: string }> };
    for (const command of external.commands ?? []) {
      if (!isCanonicalRepoPath(command.build_index_path))
        throw new Error("External runtime build-index path is noncanonical");
      const indexPath = join(repo, command.build_index_path);
      add(indexPath);
      const index = JSON.parse(
        new TextDecoder().decode(readBundleFile(repo, command.build_index_path)),
      ) as {
        builds?: Array<{ receipt_path?: string }>;
      };
      for (const build of index.builds ?? []) {
        if (!isCanonicalRepoPath(build.receipt_path))
          throw new Error("External runtime native receipt path is noncanonical");
        add(join(dirname(indexPath), build.receipt_path));
      }
    }
  }
  for (const shard of wave.shards) {
    for (const file of ["receipt.json", "stryker.json", "mutation.json"])
      add(join(mutationRoot, shard.id, file));
    add(join(coverageRoot, shard.id, "receipt.json"));
    const native = readPublishedCoverage(join(coverageRoot, shard.id, "coverage"));
    for (const file of [
      native.latestPath,
      native.receiptPath,
      native.provenancePath,
      native.lcovPath,
      ...native.targetProofPaths,
    ])
      add(file);
    const provenance = JSON.parse(readFileSync(native.provenancePath, "utf8")) as {
      behavior_evidence?: { text?: unknown };
    };
    const behavior = provenance.behavior_evidence?.text;
    if (behavior !== undefined) {
      if (typeof behavior !== "string") throw new Error("Coverage behavior evidence is malformed");
      const proof = JSON.parse(behavior) as { terminal?: Array<Record<string, unknown>> };
      if (!Array.isArray(proof.terminal))
        throw new Error("Coverage behavior terminal evidence is malformed");
      for (const terminal of proof.terminal)
        for (const key of ["manifest_path", "result_path", "log_path"] as const) {
          const path = terminal[key];
          if (typeof path !== "string" || !isCanonicalRepoPath(path))
            throw new Error("Coverage behavior artifact path is noncanonical");
          add(join(repo, path));
        }
    }
  }
  const ledger = JSON.parse(readFileSync(join(repo, wave.dynamic_import_ledger_path), "utf8")) as {
    runtime_witnesses: { execution_receipt_path: string }[];
  };
  for (const witness of ledger.runtime_witnesses) {
    const receipt = join(repo, witness.execution_receipt_path);
    for (const file of [
      receipt,
      join(dirname(receipt), "manifest.json"),
      join(dirname(receipt), "result.json"),
    ])
      add(file);
  }
  const output = resolve(options.destination);
  if (existsSync(output)) throw new Error("Quality bundle destination already exists");
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".quality-bundle-"));
  try {
    const files = [...selected].sort().map((path) => {
      const bytes = readBundleFile(repo, path);
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
      return { path, sha256: hash(bytes) };
    });
    for (const file of files)
      if (hash(readBundleFile(repo, file.path)) !== file.sha256)
        throw new Error("Evidence changed during export");
    const index = {
      version: 1,
      commit_sha: commit,
      wave_id: wave.wave_id,
      acceptance_path: relative(repo, acceptance),
      mutation_union_path: relative(repo, options.mutationUnionPath),
      coverage_union_path: relative(repo, options.coverageUnionPath),
      files,
    };
    writeFileSync(join(staging, "quality-bundle.json"), `${JSON.stringify(index, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(staging, output);
    return join(output, "quality-bundle.json");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
