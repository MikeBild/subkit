import type { FindJobsOptions, JobWithMetadata, Schedule } from "pg-boss";
import { QUEUE_DEFINITIONS, QUEUE_NAMES } from "./queues.ts";

export interface TenantErasureQueue {
  getQueues(): Promise<Array<{ name: string }>>;
  getSchedules(): Promise<Schedule[]>;
  findJobs<T>(name: string, options?: FindJobsOptions): Promise<Array<JobWithMetadata<T>>>;
  cancel(name: string, ids: string[]): Promise<unknown>;
  deleteJob(name: string, ids: string[]): Promise<unknown>;
  unschedule(name: string, key?: string): Promise<void>;
}

interface TenantQueueTargets {
  tenant_id: string;
  event_ids: number[];
  workspaces: Array<{ platform: string; workspace_id: string }>;
}

export class TenantQueueDrainRequired extends Error {
  constructor() {
    super("tenant_erasure_queue_drain_required");
    this.name = "TenantQueueDrainRequired";
  }
}

function selectorsFor(name: string, targets: TenantQueueTargets): Record<string, unknown>[] {
  const base = name.endsWith(".dlq") ? name.slice(0, -4) : name;
  const selectors: Record<string, unknown>[] = [{ tenant_id: targets.tenant_id }];
  if (base === "event.fanout")
    for (const eventId of targets.event_ids) selectors.push({ event_row_id: eventId });
  if (base === "chat.event")
    for (const workspace of targets.workspaces)
      selectors.push({
        event: { platform: workspace.platform, workspace_id: workspace.workspace_id },
      });
  return selectors;
}

function matches(value: unknown, selector: Record<string, unknown>): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(selector).every(([key, expected]) =>
    expected !== null && typeof expected === "object" && !Array.isArray(expected)
      ? matches(record[key], expected as Record<string, unknown>)
      : record[key] === expected,
  );
}

export async function eraseTenantQueueJobs(boss: TenantErasureQueue, targets: TenantQueueTargets) {
  const allowed = new Set<string>(QUEUE_NAMES);
  for (const name of QUEUE_NAMES) {
    const deadLetter = QUEUE_DEFINITIONS[name].queue.deadLetter;
    if (deadLetter) allowed.add(deadLetter);
  }
  const inventory = await boss.getQueues();
  const platformQueue = "__pgboss__send-it";
  if (inventory.some((queue) => !allowed.has(queue.name) && queue.name !== platformQueue))
    throw new Error("tenant_erasure_queue_unclassified");
  const schedules = await boss.getSchedules();
  if (schedules.length > 0) throw new Error("tenant_erasure_sdk_schedules_require_review");
  if (
    inventory.some((queue) => queue.name === platformQueue) &&
    (await boss.findJobs(platformQueue)).length > 0
  )
    throw new Error("tenant_erasure_sdk_forwarding_requires_drain");
  const queues = inventory.filter((queue) => queue.name !== platformQueue);
  const removedSchedules = 0;
  const selected: Array<{ name: string; ids: string[]; active: string[] }> = [];
  for (const queue of queues) {
    const jobs = new Map<string, JobWithMetadata<unknown>>();
    for (const selector of selectorsFor(queue.name, targets)) {
      const candidates = await boss.findJobs<unknown>(queue.name, { data: selector });
      for (const job of candidates) {
        if (!matches(job.data, selector)) throw new Error("tenant_erasure_queue_selector_mismatch");
        jobs.set(job.id, job);
      }
    }
    selected.push({
      name: queue.name,
      ids: [...jobs.keys()],
      active: [...jobs.values()].filter((job) => job.state === "active").map((job) => job.id),
    });
  }
  const active = selected.filter((queue) => queue.active.length > 0);
  if (active.length > 0) {
    for (const queue of active) await boss.cancel(queue.name, queue.active);
    throw new TenantQueueDrainRequired();
  }
  let removedJobs = 0;
  for (const queue of selected) {
    if (queue.ids.length === 0) continue;
    await boss.deleteJob(queue.name, queue.ids);
    removedJobs += queue.ids.length;
  }
  for (const queue of queues)
    for (const selector of selectorsFor(queue.name, targets))
      if ((await boss.findJobs(queue.name, { data: selector })).length > 0)
        throw new Error("tenant_erasure_queue_not_empty");
  return { jobs: removedJobs, schedules: removedSchedules };
}
