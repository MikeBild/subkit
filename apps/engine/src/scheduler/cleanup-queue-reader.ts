import type pg from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { createBossReadOnlyReader, EXECUTION_RUN_QUEUE } from "../queue/index.ts";
import { collectListPages, listAllSchedules, QUEUE_LIST_PAGE_SIZE } from "../queue/list-all.ts";

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

interface CleanupReadAdapter {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  readonly rowsRemaining: number;
  readonly bytesRemaining: number;
}

type Row = Record<string, unknown>;
type RowDeliveryAndBilling = (row: Row) => { row: Row | null; billed: boolean };

const billEveryRow: RowDeliveryAndBilling = (row) => ({ row, billed: true });

function pendingJobsWithUnfilteredPageEnd(text: string): string {
  return `WITH page AS MATERIALIZED (${text}),
    page_end AS (
      SELECT id AS cleanup_page_last_id, (SELECT count(*)::int FROM page) AS cleanup_page_rows
      FROM page ORDER BY "createdOn" DESC, id DESC LIMIT 1
    )
    SELECT pending.*, page_end.cleanup_page_last_id, page_end.cleanup_page_rows
    FROM page_end
    LEFT JOIN (SELECT * FROM page WHERE state IN ('created', 'retry', 'active')) AS pending ON true
    ORDER BY pending."createdOn", pending.id`;
}

export async function loadCleanupQueuePayloads(
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget = CLEANUP_QUEUE_BUDGET,
  readProduct?: (reader: CleanupReadAdapter) => Promise<void>,
  pageSize: number = QUEUE_LIST_PAGE_SIZE,
): Promise<Array<{ tenant_id: string | null; payload: string }>> {
  const deadline = performance.now() + budget.deadline_ms;
  let rowsRemaining = budget.rows;
  let bytesRemaining = budget.bytes;
  const remaining = () => {
    const duration = Math.floor(deadline - performance.now());
    if (duration <= 0) throw new Error("files_cleanup_queue_deadline_exceeded");
    return duration;
  };
  const read = async (
    text: string,
    values: unknown[] | undefined,
    visit: RowDeliveryAndBilling,
  ) => {
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
      await client.query(`DECLARE files_cleanup_queue_cursor NO SCROLL CURSOR FOR ${text}`, values);
      const rows: Record<string, unknown>[] = [];
      for (;;) {
        remaining();
        const result = await client.query<Record<string, unknown>>(
          "FETCH FORWARD 1 FROM files_cleanup_queue_cursor",
        );
        if (result.rows.length === 0) break;
        const fetched = result.rows[0];
        if (!fetched) throw new Error("files_cleanup_queue_cursor_invalid");
        const { row, billed } = visit(fetched);
        if (!row) continue;
        if (billed) {
          rowsRemaining--;
          bytesRemaining -= Buffer.byteLength(JSON.stringify(row));
          if (rowsRemaining < 0 || bytesRemaining < 0)
            throw new Error("files_cleanup_queue_budget_exceeded");
        }
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
  };
  const adapter: CleanupReadAdapter = {
    get rowsRemaining() {
      return rowsRemaining;
    },
    get bytesRemaining() {
      return bytesRemaining;
    },
    executeSql: (text: string, values?: unknown[]) => read(text, values, billEveryRow),
  };
  const reader = createBossReadOnlyReader(boss, adapter);
  if (readProduct) await readProduct(adapter);
  const budgetBeforeJobScan = { rows: rowsRemaining, bytes: bytesRemaining };
  const jobs = await collectListPages<JobWithMetadata<unknown>, string>(async (after) => {
    const scanStartsOver = after === undefined;
    if (scanStartsOver) {
      rowsRemaining = budgetBeforeJobScan.rows;
      bytesRemaining = budgetBeforeJobScan.bytes;
    }
    let cursorJobLookupPrecedesPage = after !== undefined;
    let page: { rows: number; lastId: string } | undefined;
    const pendingJobs = {
      executeSql(text: string, values?: unknown[]) {
        if (cursorJobLookupPrecedesPage) {
          cursorJobLookupPrecedesPage = false;
          return read(text, values, (row) => ({ row, billed: false }));
        }
        return read(pendingJobsWithUnfilteredPageEnd(text), values, (fetched) => {
          const { cleanup_page_rows: rows, cleanup_page_last_id: lastId, ...job } = fetched;
          if (typeof rows !== "number" || typeof lastId !== "string")
            throw new Error("files_cleanup_queue_page_invalid");
          page = { rows, lastId };
          return { row: job.id == null ? null : job, billed: true };
        });
      },
    };
    const rows = await reader.findJobs<unknown>(EXECUTION_RUN_QUEUE, {
      db: pendingJobs,
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    const rowsBypassedPendingFilter = !page && rows.length > 0;
    if (rowsBypassedPendingFilter) throw new Error("files_cleanup_queue_page_invalid");
    return { rows, nextPageCursor: page && page.rows >= pageSize ? page.lastId : undefined };
  });
  const schedules = await listAllSchedules(reader, pageSize);
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
