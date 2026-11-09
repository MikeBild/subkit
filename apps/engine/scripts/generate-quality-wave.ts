import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { externalRuntimeDockerTests, testExecutionKind } from "./audit/external-runtime-tests.ts";
import {
  createClosureAnalysis,
  reviewedClosurePlanFromAnalysis,
} from "./audit/mutation-closure.ts";
import { mutationClosureFiles } from "./audit/mutation-inputs.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
} from "./audit/pure-targets.ts";
import { parseQualityShardPolicy } from "./audit/quality-shard-policy.ts";
import { reviewedRuntimeWitnesses } from "./audit/runtime-witnesses.ts";

const repo = resolve(import.meta.dir, "../../..");
function required(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
const ledgerPath = required("--dynamic-ledger");
const waveId = required("--wave-id");
if (!/^[a-z0-9][a-z0-9-]*$/.test(waveId)) throw new Error("Invalid wave id");
const out = resolve(repo, required("--out"));
const raw = readFileSync(join(repo, "apps/engine/.quality-shard-policy.json"), "utf8");
const files = mutationClosureFiles(repo);
const read = (path: string) => {
  try {
    return readFileSync(join(repo, path), "utf8");
  } catch {
    return null;
  }
};
const runtime = reviewedRuntimeWitnesses({
  ledger: JSON.parse(read(ledgerPath) ?? "null"),
  files,
  readText: read,
  readArtifact: read,
});
if (runtime.errors.length) throw new Error(runtime.errors.join("; "));
const entries = assertCompletePureTargetInventory(files);
const policy = parseQualityShardPolicy(
  JSON.parse(raw),
  entries.map((entry) => entry.owner_shard),
);
const shards = policy.shards;
const unresolved: Array<{ shard: string; consumer: string }> = [];
const tags = new Map(shards.map((shard) => [shard.id, shard.resource_tags]));
const grouped = new Map<string, string[]>();
for (const entry of entries)
  grouped.set(entry.owner_shard, [...(grouped.get(entry.owner_shard) ?? []), entry.path]);
const analysis = createClosureAnalysis({
  files,
  readText: read,
  tsconfig: read("tsconfig.json") ?? "{}",
  cockpitTsconfig: read("apps/cockpit/tsconfig.json") ?? "{}",
});
const externalRuntimeTests = externalRuntimeDockerTests(repo);
const next = [...grouped.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([id, targets]) => {
    const shard = { id, targets: targets.sort(), resource_tags: tags.get(id) ?? [] };
    const closure = reviewedClosurePlanFromAnalysis(analysis, {
      targets: shard.targets,
      declared: [],
    });
    const consumers = closure.consumers.map((consumer) => {
      const witness = consumer.witnesses[0] ?? [...(runtime.witnesses.get(consumer.path) ?? [])][0];
      if (witness && !closure.tests.some((test) => test.path === witness))
        closure.tests.push({
          path: witness,
          kind: "consumer_contract",
          covers_targets: shard.targets,
          rationale: "Hash-bound independently reviewed source launch in runtime witness ledger.",
        });
      if (!witness) unresolved.push({ shard: shard.id, consumer: consumer.path });
      return { path: consumer.path, witnesses: witness ? [witness] : [] };
    });
    return {
      ...shard,
      tests: closure.tests.map((test) => ({
        ...test,
        execution: testExecutionKind(test.path, externalRuntimeTests),
      })),
      consumers,
    };
  });
const zero = "0".repeat(64);
const manifest = {
  version: 1,
  status: "candidate_unaccepted",
  wave_id: waveId,
  source_freeze_sha256: zero,
  test_freeze_sha256: zero,
  target_digest_sha256: canonicalPureTargetDigest(entries),
  config_sha256: zero,
  lock_sha256: zero,
  equivalence_manifest_path: policy.equivalence_manifest_path,
  equivalence_manifest_sha256: zero,
  dynamic_import_ledger_path: ledgerPath,
  dynamic_import_ledger_sha256: zero,
  non_incremental: true,
  worker_budget: policy.worker_budget,
  external_runtime_tests: externalRuntimeTests,
  target_count: entries.length,
  shards: next,
  unresolved_consumer_witnesses: unresolved,
};
if (unresolved.length) throw new Error(`Missing runtime witnesses: ${JSON.stringify(unresolved)}`);
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    output: relative(repo, out),
    targets: entries.length,
    shards: next.length,
    unresolved: unresolved.length,
  }),
);
