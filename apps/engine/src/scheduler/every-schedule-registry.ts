export interface EveryScheduleDefinition {
  schedule_id: string;
  tenant_id: string;
  workflow_id: string;
  seconds: number;
}

type Registration = {
  definition: EveryScheduleDefinition;
  seen: number;
  dispose: () => void;
};

export class EveryScheduleRegistry {
  private registrations = new Map<string, Registration>();
  private generation = 0;
  private phase: "idle" | "discover" | "prune" = "idle";
  private pruning: MapIterator<[string, Registration]> | null = null;
  private remaining = 0;

  constructor(private readonly install: (definition: EveryScheduleDefinition) => () => void) {}

  begin(): number {
    if (this.phase !== "idle") throw new Error("schedule_generation_in_progress");
    if (this.generation >= Number.MAX_SAFE_INTEGER)
      throw new Error("schedule_generation_exhausted");
    this.generation++;
    this.phase = "discover";
    return this.generation;
  }

  observe(generation: number, definition: EveryScheduleDefinition): void {
    if (generation !== this.generation || this.phase !== "discover") return;
    this.upsert(generation, definition);
  }

  private upsert(generation: number, definition: EveryScheduleDefinition): void {
    const prior = this.registrations.get(definition.schedule_id);
    if (
      prior &&
      prior.definition.tenant_id === definition.tenant_id &&
      prior.definition.workflow_id === definition.workflow_id &&
      prior.definition.seconds === definition.seconds
    ) {
      prior.seen = generation;
      return;
    }
    const dispose = this.install(definition);
    prior?.dispose();
    this.registrations.set(definition.schedule_id, { definition, seen: generation, dispose });
  }

  finish(generation: number, complete: boolean): void {
    if (generation !== this.generation || this.phase !== "discover") return;
    if (!complete) {
      this.phase = "idle";
      return;
    }
    this.phase = "prune";
    this.pruning = this.registrations.entries();
    this.remaining = this.registrations.size;
  }

  async prune(
    generation: number,
    inspect: (definition: EveryScheduleDefinition) => Promise<EveryScheduleDefinition | null>,
  ): Promise<boolean> {
    if (generation !== this.generation || this.phase !== "prune" || !this.pruning) return true;
    let visited = 0;
    while (this.remaining > 0 && visited < 64) {
      const next = this.pruning.next();
      if (next.done) break;
      this.remaining--;
      visited++;
      const [id, entry] = next.value;
      if (entry.seen === generation) continue;
      let current: EveryScheduleDefinition | null;
      try {
        current = await inspect(entry.definition);
      } catch {
        continue;
      }
      if (generation !== this.generation || this.phase !== "prune") return true;
      if (this.registrations.get(id) !== entry) continue;
      if (current) this.upsert(generation, current);
      else {
        entry.dispose();
        this.registrations.delete(id);
      }
    }
    if (this.remaining > 0 && visited === 64) return false;
    this.phase = "idle";
    this.pruning = null;
    this.remaining = 0;
    return true;
  }

  clear(): void {
    if (this.generation < Number.MAX_SAFE_INTEGER) this.generation++;
    this.phase = "idle";
    this.pruning = null;
    this.remaining = 0;
    for (const entry of this.registrations.values()) entry.dispose();
    this.registrations.clear();
  }
}
