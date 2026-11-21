import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/index.ts";
import { type EveryScheduleDefinition, EveryScheduleRegistry } from "./every-schedule-registry.ts";
import { boundedTransaction, SWEEP_METADATA_MAX_BYTES, SWEEP_PAGE_LIMIT } from "./sweep-cursor.ts";
import { sweepSource } from "./sweep-cursor-source.ts";
import { readEveryScheduleDefinition } from "./workflow-schedule-sweep.ts";

type Scan = {
  kind: "scan";
  generation: number;
  cutoff: Date;
  upper: string;
  after: string | null;
  failed: boolean;
};
type State = Scan | { kind: "prune"; generation: number };
const epochSchema = z.object({ cutoff: z.coerce.date(), upper: z.string().uuid().nullable() });
const metadataSchema = z
  .array(z.object({ id: z.string().uuid(), tenant_id: z.string().uuid() }).strict())
  .max(SWEEP_PAGE_LIMIT);

export class EveryScheduleSweep {
  private readonly registry: EveryScheduleRegistry;
  private state: State | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    install: (definition: EveryScheduleDefinition) => () => void,
  ) {
    this.registry = new EveryScheduleRegistry(install);
  }

  resume(): void {
    this.stopped = false;
  }
  stop(): void {
    this.stopped = true;
    this.state = null;
    this.registry.clear();
  }
  reconcile(): Promise<void> {
    if (this.stopped || this.running) return Promise.resolve();
    const task = Promise.resolve().then(() => this.pass());
    this.running = task;
    const finished = () => {
      if (this.running === task) this.running = null;
    };
    void task.then(finished, finished);
    return task;
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    if (!this.state) {
      const result = await boundedTransaction(this.db, (tx) =>
        tx.execute(sql`
        WITH observed AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS cutoff)
        SELECT cutoff,(SELECT id FROM (${sweepSource("workflow-cron")}) source
          WHERE created_at<=observed.cutoff ORDER BY id DESC LIMIT 1) AS upper FROM observed`),
      );
      if (this.stopped) return;
      const epoch = epochSchema.parse(result.rows[0]);
      const generation = this.registry.begin();
      if (!epoch.upper) {
        this.registry.finish(generation, true);
        this.state = { kind: "prune", generation };
      } else
        this.state = {
          kind: "scan",
          generation,
          cutoff: epoch.cutoff,
          upper: epoch.upper,
          after: null,
          failed: false,
        };
    }
    const state = this.state;
    if (state.kind === "prune") {
      const complete = await this.registry.prune(state.generation, (definition) =>
        readEveryScheduleDefinition(this.db, definition),
      );
      if (complete && this.state === state) this.state = null;
      return;
    }
    const result = await boundedTransaction(this.db, (tx) =>
      tx.execute(sql`
      SELECT id,tenant_id FROM (${sweepSource("workflow-cron")}) source
      WHERE created_at<=${state.cutoff} AND id<=${state.upper}::uuid
      ${state.after ? sql`AND id>${state.after}::uuid` : sql``}
      ORDER BY id ASC LIMIT ${SWEEP_PAGE_LIMIT}`),
    );
    const rows = metadataSchema.parse(result.rows);
    if (Buffer.byteLength(JSON.stringify(rows)) > SWEEP_METADATA_MAX_BYTES)
      throw new Error("schedule_metadata_invalid");
    const started = performance.now();
    let visited = 0;
    for (const candidate of rows) {
      if (this.stopped || this.state !== state || performance.now() - started >= 5_000) return;
      try {
        const definition = await readEveryScheduleDefinition(this.db, {
          schedule_id: candidate.id,
          tenant_id: candidate.tenant_id,
        });
        if (this.stopped || this.state !== state) return;
        if (definition) this.registry.observe(state.generation, definition);
      } catch {
        state.failed = true;
        logger.warn({
          module: "scheduler",
          action: "schedule.timer_discovery_failed",
          msg: "timer descriptor read failed; retaining prior registrations",
          schedule_id: candidate.id,
          tenant_id: candidate.tenant_id,
        });
      }
      state.after = candidate.id;
      visited++;
    }
    if (visited === rows.length && rows.length < SWEEP_PAGE_LIMIT) {
      this.registry.finish(state.generation, !state.failed);
      this.state = state.failed ? null : { kind: "prune", generation: state.generation };
    }
  }
}
