import { expect, test } from "bun:test";
import type { FindJobsOptions, JobWithMetadata, ListOptions, Schedule } from "pg-boss";
import { collectListPages, findAllJobs, listAllQueues, listAllSchedules } from "./list-all.ts";

const CURSOR_LOST = "findJobs: after names a row that no longer exists";

function jobStore(ids: string[]) {
  const calls: FindJobsOptions[] = [];
  return {
    calls,
    ids,
    async findJobs<T>(_name: string, options: FindJobsOptions = {}) {
      calls.push(options);
      const start = options.after === undefined ? 0 : ids.indexOf(options.after) + 1;
      if (options.after !== undefined && start === 0) throw new Error(CURSOR_LOST);
      return ids
        .slice(start, start + (options.limit ?? 1000))
        .map((id) => ({ id })) as JobWithMetadata<T>[];
    },
  };
}

test("jobs beyond the first page are found and the caller's filter reaches every page", async () => {
  const store = jobStore(["a", "b", "c", "d", "e"]);
  const jobs = await findAllJobs(store, "execution.run", { data: { tenant_id: "t" } }, 2);
  expect(jobs.map((job) => job.id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(store.calls).toEqual([
    { data: { tenant_id: "t" }, limit: 2 },
    { data: { tenant_id: "t" }, limit: 2, after: "b" },
    { data: { tenant_id: "t" }, limit: 2, after: "d" },
  ]);
});

test("a list that ends exactly on a page boundary reads one more, empty page", async () => {
  const store = jobStore(["a", "b", "c", "d"]);
  expect(await findAllJobs(store, "execution.run", {}, 2)).toHaveLength(4);
  expect(store.calls).toHaveLength(3);
});

test("a cursor job deleted between pages restarts the list instead of truncating it", async () => {
  const store = jobStore(["a", "b", "c", "d", "e"]);
  const find = store.findJobs.bind(store);
  let deleted = false;
  store.findJobs = async <T>(name: string, options?: FindJobsOptions) => {
    if (options?.after === "b" && !deleted) {
      deleted = true;
      store.ids.splice(store.ids.indexOf("b"), 1);
    }
    return find<T>(name, options);
  };
  const jobs = await findAllJobs(store, "execution.run", {}, 2);
  expect(jobs.map((job) => job.id)).toEqual(["a", "c", "d", "e"]);
});

test("a cursor that keeps vanishing fails instead of returning a partial list", async () => {
  let reads = 0;
  const boss = {
    async findJobs<T>(_name: string, options?: FindJobsOptions) {
      reads += 1;
      if (options?.after !== undefined) throw new Error(CURSOR_LOST);
      return [{ id: "a" }, { id: "b" }] as JobWithMetadata<T>[];
    },
  };
  await expect(findAllJobs(boss, "execution.run", {}, 2)).rejects.toThrow("queue_list_cursor_lost");
  expect(reads).toBe(6);
});

test("other errors and a cursor that does not advance are not retried", async () => {
  let reads = 0;
  await expect(
    collectListPages(async () => {
      reads += 1;
      throw new Error("connection refused");
    }),
  ).rejects.toThrow("connection refused");
  expect(reads).toBe(1);
  const ignoresCursor = {
    async findJobs<T>() {
      return [{ id: "a" }, { id: "b" }] as JobWithMetadata<T>[];
    },
  };
  await expect(findAllJobs(ignoresCursor, "execution.run", {}, 2)).rejects.toThrow(
    "queue_list_cursor_stalled",
  );
});

test("queues and schedules are paged by name and by name and key", async () => {
  const names = ["a", "b", "c", "d", "e"];
  const queueCalls: Array<ListOptions | undefined> = [];
  const queues = await listAllQueues(
    {
      async getQueues(_names?: string[], options?: ListOptions) {
        queueCalls.push(options);
        const after = options?.after;
        return names
          .filter((name) => after === undefined || name > after)
          .slice(0, options?.limit)
          .map((name) => ({ name }));
      },
    },
    2,
  );
  expect(queues.map((queue) => queue.name)).toEqual(names);
  expect(queueCalls).toEqual([{ limit: 2 }, { limit: 2, after: "b" }, { limit: 2, after: "d" }]);

  const rows = ["k1", "k2", "k3"].map((key) => ({ name: "execution.run", key }) as Schedule);
  const scheduleCalls: unknown[] = [];
  const schedules = await listAllSchedules(
    {
      async getSchedules(
        _name?: string,
        _key?: string,
        options?: ListOptions<Pick<Schedule, "name" | "key">>,
      ) {
        scheduleCalls.push(options);
        const after = options?.after;
        return rows.filter((row) => !after || row.key > after.key).slice(0, options?.limit);
      },
    },
    2,
  );
  expect(schedules.map((schedule) => schedule.key)).toEqual(["k1", "k2", "k3"]);
  expect(scheduleCalls).toEqual([
    { limit: 2 },
    { limit: 2, after: { name: "execution.run", key: "k2" } },
  ]);
});
