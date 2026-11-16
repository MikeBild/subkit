export interface QualityShardPolicy {
  version: 1;
  worker_budget: number;
  mutation_test_radius?: number;
  equivalence_manifest_path: string;
  shards: readonly { id: string; resource_tags: readonly string[] }[];
}

export function assertWaveMatchesQualityPolicy(
  policy: QualityShardPolicy,
  wave: {
    worker_budget: number;
    equivalence_manifest_path: string;
    shards: readonly { id: string; resource_tags: readonly string[] }[];
  },
): void {
  if (
    wave.worker_budget !== policy.worker_budget ||
    wave.equivalence_manifest_path !== policy.equivalence_manifest_path
  )
    throw new Error("Wave differs from reviewed quality policy");
  const ids = new Set(wave.shards.map((shard) => shard.id));
  if (
    ids.size !== wave.shards.length ||
    ids.size !== policy.shards.length ||
    policy.shards.some((shard) => !ids.has(shard.id))
  )
    throw new Error("Wave shard inventory differs from reviewed quality policy");
  const reviewed = new Map(policy.shards.map((shard) => [shard.id, shard.resource_tags]));
  for (const shard of wave.shards) {
    const tags = reviewed.get(shard.id);
    if (
      !tags ||
      tags.length !== shard.resource_tags.length ||
      new Set(shard.resource_tags).size !== tags.length ||
      tags.some((tag) => !shard.resource_tags.includes(tag))
    )
      throw new Error(`Wave resource policy differs: ${shard.id}`);
  }
}

export function parseQualityShardPolicy(
  value: unknown,
  requiredOwners: readonly string[],
): QualityShardPolicy {
  if (!value || typeof value !== "object") throw new Error("Invalid quality policy");
  const policy = value as QualityShardPolicy;
  if (
    policy.version !== 1 ||
    !Number.isSafeInteger(policy.worker_budget) ||
    policy.worker_budget < 1 ||
    (policy.mutation_test_radius !== undefined &&
      (!Number.isSafeInteger(policy.mutation_test_radius) || policy.mutation_test_radius < 1)) ||
    policy.equivalence_manifest_path !== "apps/engine/.mutation-equivalents.json" ||
    !Array.isArray(policy.shards)
  )
    throw new Error("Invalid quality policy header");
  const owners = new Set<string>();
  for (const shard of policy.shards) {
    if (
      !shard ||
      typeof shard.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(shard.id) ||
      owners.has(shard.id) ||
      !Array.isArray(shard.resource_tags) ||
      shard.resource_tags.some(
        (tag: unknown) => typeof tag !== "string" || !["db", "ports", "global-state"].includes(tag),
      ) ||
      new Set(shard.resource_tags).size !== shard.resource_tags.length
    )
      throw new Error("Invalid or duplicate quality shard resource policy");
    owners.add(shard.id);
  }
  for (const owner of requiredOwners) {
    if (!owners.has(owner)) throw new Error(`Missing reviewed resource policy: ${owner}`);
  }
  return policy;
}

export function assertCanonicalWaveOwners(
  wave: { shards: readonly { id: string; targets: readonly string[] }[] },
  entries: readonly { path: string; owner_shard: string }[],
): void {
  const owners = new Map(entries.map((entry) => [entry.path, entry.owner_shard]));
  for (const shard of wave.shards) {
    for (const target of shard.targets) {
      if (owners.get(target) !== shard.id)
        throw new Error(`Target assigned outside its canonical owner: ${target}`);
    }
  }
}
