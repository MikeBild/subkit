import type { FindJobsOptions, JobWithMetadata, ListOptions, Schedule } from "pg-boss";
export const QUEUE_LIST_PAGE_SIZE = 1000;

const CURSOR_LOST_ATTEMPTS = 3;

export interface ListPage<Row, Cursor> {
  rows: Row[];
  nextPageCursor: Cursor | undefined;
}

type ScheduleCursor = Pick<Schedule, "name" | "key">;

interface QueueLister<Queue> {
  getQueues(names?: string[], options?: ListOptions): Promise<Queue[]>;
}

interface ScheduleLister {
  getSchedules(
    name?: string,
    key?: string,
    options?: ListOptions<ScheduleCursor>,
  ): Promise<Schedule[]>;
}

interface JobFinder {
  findJobs<T>(name: string, options?: FindJobsOptions): Promise<Array<JobWithMetadata<T>>>;
}
function isCursorJobDeletedBetweenPages(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("after names a row that no longer exists")
  );
}

export async function collectListPages<Row, Cursor>(
  readPage: (after: Cursor | undefined) => Promise<ListPage<Row, Cursor>>,
): Promise<Row[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const rows: Row[] = [];
      let after: Cursor | undefined;
      for (;;) {
        const page = await readPage(after);
        for (const row of page.rows) rows.push(row);
        if (page.nextPageCursor === undefined) return rows;
        if (after !== undefined && JSON.stringify(page.nextPageCursor) === JSON.stringify(after))
          throw new Error("queue_list_cursor_stalled");
        after = page.nextPageCursor;
      }
    } catch (error) {
      if (!isCursorJobDeletedBetweenPages(error)) throw error;
      if (attempt >= CURSOR_LOST_ATTEMPTS)
        throw new Error("queue_list_cursor_lost", { cause: error });
    }
  }
}

function pageOf<Row, Cursor>(
  rows: Row[],
  pageSize: number,
  cursorOf: (last: Row) => Cursor,
): ListPage<Row, Cursor> {
  const last = rows.at(-1);
  return {
    rows,
    nextPageCursor: last === undefined || rows.length < pageSize ? undefined : cursorOf(last),
  };
}

export function listAllQueues<Queue extends { name: string }>(
  boss: QueueLister<Queue>,
  pageSize = QUEUE_LIST_PAGE_SIZE,
): Promise<Queue[]> {
  return collectListPages<Queue, string>(async (after) =>
    pageOf(
      await boss.getQueues(undefined, {
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      }),
      pageSize,
      (queue) => queue.name,
    ),
  );
}

export function listAllSchedules(
  boss: ScheduleLister,
  pageSize = QUEUE_LIST_PAGE_SIZE,
): Promise<Schedule[]> {
  return collectListPages<Schedule, ScheduleCursor>(async (after) =>
    pageOf(
      await boss.getSchedules(undefined, undefined, {
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      }),
      pageSize,
      (schedule) => ({ name: schedule.name, key: schedule.key }),
    ),
  );
}

export function findAllJobs<T>(
  boss: JobFinder,
  name: string,
  options: Omit<FindJobsOptions, "limit" | "after"> = {},
  pageSize = QUEUE_LIST_PAGE_SIZE,
): Promise<Array<JobWithMetadata<T>>> {
  return collectListPages<JobWithMetadata<T>, string>(async (after) =>
    pageOf(
      await boss.findJobs<T>(name, {
        ...options,
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      }),
      pageSize,
      (job) => job.id,
    ),
  );
}
