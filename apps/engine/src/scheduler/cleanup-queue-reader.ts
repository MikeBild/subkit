import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { createBossReadOnlyReader, EXECUTION_RUN_QUEUE } from "../queue/index.ts";

export interface CleanupQueueBudget {
  rows: number;
  bytes: number;
  deadline_ms: number;
}

export const CLEANUP_QUEUE_BUDGET: CleanupQueueBudget = {
  rows: 4096,
  bytes: 8 * 1024 * 1024,
  deadline_ms: 15_000,
};

export interface CleanupReadAdapter {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  readonly rowsRemaining: number;
  readonly bytesRemaining: number;
}

export async function loadCleanupQueuePayloads(
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget = CLEANUP_QUEUE_BUDGET,
  readProduct?: (reader: CleanupReadAdapter) => Promise<void>,
): Promise<Array<{ tenant_id: string | null; payload: string }>> {
  const deadline = performance.now() + budget.deadline_ms;
  let rowsRemaining = budget.rows;
  let bytesRemaining = budget.bytes;
  const remaining = () => {
    const duration = Math.floor(deadline - performance.now());
    if (duration <= 0) throw new Error("files_cleanup_queue_deadline_exceeded");
    return duration;
  };
  const adapter: CleanupReadAdapter = {
    get rowsRemaining() {
      return rowsRemaining;
    },
    get bytesRemaining() {
      return bytesRemaining;
    },
    async executeSql(text: string, values?: unknown[]) {
      let acquisitionExpired = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const acquisitionTimeout = remaining();
      const acquisition = pool.connect();
      void acquisition.then(
        (client) => {
          if (acquisitionExpired) client.release();
        },
        () => {},
      );
      let client: pg.PoolClient;
      try {
        client = await Promise.race([
          acquisition,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              acquisitionExpired = true;
              reject(new Error("files_cleanup_queue_deadline_exceeded"));
            }, acquisitionTimeout);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      let released = false;
      let deadlineExpired = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        deadlineTimer = setTimeout(() => {
          deadlineExpired = true;
          released = true;
          client.release(true);
        }, remaining());
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining())]);
        await client.query(
          `DECLARE files_cleanup_queue_cursor NO SCROLL CURSOR FOR ${text}`,
          values,
        );
        const rows: Record<string, unknown>[] = [];
        for (;;) {
          remaining();
          const result = await client.query<Record<string, unknown>>(
            "FETCH FORWARD 1 FROM files_cleanup_queue_cursor",
          );
          if (result.rows.length === 0) break;
          const row = result.rows[0];
          if (!row) throw new Error("files_cleanup_queue_cursor_invalid");
          rowsRemaining--;
          bytesRemaining -= Buffer.byteLength(JSON.stringify(row));
          if (rowsRemaining < 0 || bytesRemaining < 0)
            throw new Error("files_cleanup_queue_budget_exceeded");
          rows.push(row);
        }
        return { rows };
      } catch (error) {
        if (deadlineExpired) throw new Error("files_cleanup_queue_deadline_exceeded");
        throw error;
      } finally {
        const rollbackTimer = setTimeout(() => {
          if (!released) {
            released = true;
            client.release(true);
          }
        }, 1000);
        try {
          if (!released) {
            let releaseWithError = false;
            try {
              await client.query("ROLLBACK");
            } catch {
              releaseWithError = true;
            }
            if (!released) {
              released = true;
              client.release(releaseWithError);
            }
          }
        } finally {
          clearTimeout(rollbackTimer);
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      }
    },
  };
  const reader = createBossReadOnlyReader(boss, adapter);
  if (readProduct) await readProduct(adapter);
  const jobs = await reader.findJobs<unknown>(EXECUTION_RUN_QUEUE, { db: adapter });
  const schedules = await reader.getSchedules();
  remaining();
  const parts: Array<{ tenant_id: string | null; payload: string }> = [];
  const append = (data: unknown) => {
    if (data == null) return;
    const tenant_id =
      typeof data === "object" && "tenant_id" in data && typeof data.tenant_id === "string"
        ? data.tenant_id
        : null;
    parts.push({ tenant_id, payload: JSON.stringify(data) });
  };
  for (const job of jobs) {
    if (job.state === "created" || job.state === "active" || job.state === "retry")
      append(job.data);
  }
  for (const schedule of schedules) append(schedule.data);
  return parts;
}
