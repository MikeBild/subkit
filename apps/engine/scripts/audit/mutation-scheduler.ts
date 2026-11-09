export interface SchedulableShard {
  readonly id: string;
  readonly resource_tags: readonly string[];
}

export interface ScheduledShard {
  readonly id: string;
  readonly workers: number;
}

export function planMutationBatches(
  shards: readonly SchedulableShard[],
  workerBudget: number,
): ScheduledShard[][] {
  if (!Number.isSafeInteger(workerBudget) || workerBudget < 1)
    throw new Error("Mutation worker budget must be a positive safe integer");
  const ids = new Set<string>();
  for (const shard of shards) {
    if (!shard.id || ids.has(shard.id)) throw new Error("Mutation shard ids must be unique");
    ids.add(shard.id);
    if (shard.resource_tags.some((tag) => !tag.trim()))
      throw new Error("Mutation resource tags must be nonempty");
  }
  const pending = [...shards].sort((left, right) => left.id.localeCompare(right.id));
  const batches: ScheduledShard[][] = [];
  while (pending.length > 0) {
    const selected: SchedulableShard[] = [];
    const occupied = new Set<string>();
    for (let index = 0; index < pending.length && selected.length < workerBudget; ) {
      const shard = pending[index]!;
      if (shard.resource_tags.some((tag) => occupied.has(tag))) {
        index += 1;
        continue;
      }
      selected.push(shard);
      for (const tag of shard.resource_tags) occupied.add(tag);
      pending.splice(index, 1);
    }
    const base = Math.floor(workerBudget / selected.length);
    const remaining = workerBudget % selected.length;
    batches.push(
      selected.map((shard, index) => ({
        id: shard.id,
        workers: base + (index < remaining ? 1 : 0),
      })),
    );
  }
  return batches;
}
