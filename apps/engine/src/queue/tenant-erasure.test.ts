import { expect, test } from "bun:test";
import type { FindJobsOptions, JobWithMetadata, ListOptions } from "pg-boss";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { eraseTenantQueueJobs, type TenantErasureQueue } from "./tenant-erasure.ts";

const uuid = createDeterministicUuidFactory(0x71ee012);

test("public queue selectors erase only exact tenant, event and workspace jobs", async () => {
  const target = uuid();
  const jobs = new Map<string, Array<{ id: string; state: string; data: unknown }>>([
    [
      "execution.run",
      [
        { id: "own", state: "created", data: { tenant_id: target } },
        { id: "other", state: "created", data: { tenant_id: uuid() } },
      ],
    ],
    [
      "event.fanout",
      [
        { id: "own-event", state: "created", data: { event_row_id: 12 } },
        { id: "other-event", state: "created", data: { event_row_id: 13 } },
      ],
    ],
    [
      "chat.event",
      [
        {
          id: "own-chat",
          state: "created",
          data: { event: { platform: "slack", workspace_id: "own" } },
        },
        {
          id: "other-chat",
          state: "created",
          data: { event: { platform: "slack", workspace_id: "other" } },
        },
      ],
    ],
  ]);
  function matches(data: unknown, selector: unknown): boolean {
    return (
      !!data &&
      typeof data === "object" &&
      Object.entries(selector as object).every(([key, value]) =>
        value && typeof value === "object"
          ? matches((data as Record<string, unknown>)[key], value)
          : (data as Record<string, unknown>)[key] === value,
      )
    );
  }
  const boss: TenantErasureQueue = {
    async getQueues() {
      return [...jobs.keys()].map((name) => ({ name }));
    },
    async getSchedules() {
      return [];
    },
    async findJobs<T>(name: string, options?: FindJobsOptions) {
      return (jobs.get(name) ?? []).filter((job) =>
        matches(job.data, options?.data),
      ) as JobWithMetadata<T>[];
    },
    async cancel() {
      throw new Error("not active");
    },
    async deleteJob(name, ids) {
      jobs.set(
        name,
        (jobs.get(name) ?? []).filter((job) => !ids.includes(job.id)),
      );
    },
    async unschedule() {},
  };
  expect(
    await eraseTenantQueueJobs(boss, {
      tenant_id: target,
      event_ids: [12],
      workspaces: [{ platform: "slack", workspace_id: "own" }],
    }),
  ).toEqual({ jobs: 3, schedules: 0 });
  expect([...jobs.values()].flat().map((job) => job.id)).toEqual([
    "other",
    "other-event",
    "other-chat",
  ]);
});

test("unknown queue fails closed instead of assuming its payload is tenant scoped", async () => {
  const boss = {
    async getQueues() {
      return [{ name: "unclassified.work" }];
    },
  } as unknown as TenantErasureQueue;
  await expect(
    eraseTenantQueueJobs(boss, { tenant_id: uuid(), event_ids: [], workspaces: [] }),
  ).rejects.toThrow("tenant_erasure_queue_unclassified");
});

test("existing SDK cron schedules and forwarding jobs require operator drain", async () => {
  const target = { tenant_id: uuid(), event_ids: [], workspaces: [] };
  const schedules = {
    async getQueues() {
      return [];
    },
    async getSchedules() {
      return [{}];
    },
  } as unknown as TenantErasureQueue;
  await expect(eraseTenantQueueJobs(schedules, target)).rejects.toThrow(
    "tenant_erasure_sdk_schedules_require_review",
  );
  let calls = 0;
  const forwarding = {
    async getQueues() {
      return [{ name: "__pgboss__send-it" }];
    },
    async getSchedules() {
      return [];
    },
    async findJobs() {
      calls += 1;
      return [{ id: "opaque" }];
    },
  } as unknown as TenantErasureQueue;
  await expect(eraseTenantQueueJobs(forwarding, target)).rejects.toThrow(
    "tenant_erasure_sdk_forwarding_requires_drain",
  );
  expect(calls).toBe(1);
});

function pageLikePgBoss<Row>(
  rows: Row[],
  cursor: (row: Row) => string,
  options?: ListOptions,
): Row[] {
  const after = options?.after;
  const start = after === undefined ? 0 : rows.findIndex((row) => cursor(row) === after) + 1;
  if (after !== undefined && start === 0)
    throw new Error("after names a row that no longer exists");
  return rows.slice(start, start + (options?.limit ?? 1000));
}

test("erasure removes tenant jobs beyond the first page of a queue", async () => {
  const target = uuid();
  const foreign = uuid();
  let jobs = Array.from({ length: 2500 }, (_, index) => ({
    id: `job-${index}`,
    state: "created",
    data: { tenant_id: index === 1700 ? foreign : target },
  }));
  const deleted: number[] = [];
  const boss: TenantErasureQueue = {
    async getQueues(_names, options) {
      return pageLikePgBoss([{ name: "execution.run" }], (queue) => queue.name, options);
    },
    async getSchedules() {
      return [];
    },
    async findJobs<T>(_name: string, options?: FindJobsOptions) {
      const tenant = (options?.data as { tenant_id?: string } | undefined)?.tenant_id;
      return pageLikePgBoss(
        jobs.filter((job) => job.data.tenant_id === tenant),
        (job) => job.id,
        options,
      ) as JobWithMetadata<T>[];
    },
    async cancel() {
      throw new Error("not active");
    },
    async deleteJob(_name, ids) {
      deleted.push(ids.length);
      jobs = jobs.filter((job) => !ids.includes(job.id));
    },
    async unschedule() {},
  };
  expect(
    await eraseTenantQueueJobs(boss, { tenant_id: target, event_ids: [], workspaces: [] }),
  ).toEqual({ jobs: 2499, schedules: 0 });
  expect(deleted).toEqual([2499]);
  expect(jobs.map((job) => job.id)).toEqual(["job-1700"]);
});

test("an active tenant job beyond the first page is cancelled before anything is deleted", async () => {
  const target = uuid();
  const jobs = Array.from({ length: 1200 }, (_, index) => ({
    id: `job-${index}`,
    state: index === 1100 ? "active" : "created",
    data: { tenant_id: target },
  }));
  const cancelled: string[] = [];
  const boss: TenantErasureQueue = {
    async getQueues(_names, options) {
      return pageLikePgBoss([{ name: "execution.run" }], (queue) => queue.name, options);
    },
    async getSchedules() {
      return [];
    },
    async findJobs<T>(_name: string, options?: FindJobsOptions) {
      return pageLikePgBoss(jobs, (job) => job.id, options) as JobWithMetadata<T>[];
    },
    async cancel(_name, ids) {
      cancelled.push(...ids);
    },
    async deleteJob() {
      throw new Error("must not delete while a job is active");
    },
    async unschedule() {},
  };
  await expect(
    eraseTenantQueueJobs(boss, { tenant_id: target, event_ids: [], workspaces: [] }),
  ).rejects.toThrow("tenant_erasure_queue_drain_required");
  expect(cancelled).toEqual(["job-1100"]);
});

test("an unclassified queue beyond the first page of queues still fails closed", async () => {
  const boss = {
    async getQueues(_names?: string[], options?: ListOptions) {
      return options?.after === undefined
        ? Array.from({ length: options?.limit ?? 1000 }, () => ({ name: "execution.run" }))
        : [{ name: "unclassified.work" }];
    },
  } as unknown as TenantErasureQueue;
  await expect(
    eraseTenantQueueJobs(boss, { tenant_id: uuid(), event_ids: [], workspaces: [] }),
  ).rejects.toThrow("tenant_erasure_queue_unclassified");
});
