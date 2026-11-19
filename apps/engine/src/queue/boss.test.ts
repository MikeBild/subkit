import { expect, test } from "bun:test";
import type { ListOptions, QueueResult } from "pg-boss";
import { ensureBossQueues } from "./boss.ts";
import { QUEUE_NAMES } from "./queues.ts";

function fakeBoss(input: {
  queues?: string[];
  createQueue: (name: string) => Promise<void>;
  afterCreateFailureQueues?: string[];
}) {
  let reads = 0;
  return {
    getQueues: async (): Promise<QueueResult[]> => {
      reads += 1;
      const names =
        reads > 1 ? (input.afterCreateFailureQueues ?? input.queues ?? []) : (input.queues ?? []);
      return names.map((name) => ({ name }) as QueueResult);
    },
    createQueue: async (name: string) => input.createQueue(name),
  };
}

test("required queues prevent readiness when creation fails without a concurrent creator", async () => {
  const failure = Object.assign(new Error("permission denied"), { code: "42501" });
  const boss = fakeBoss({ createQueue: async () => Promise.reject(failure) });

  await expect(ensureBossQueues(boss)).rejects.toBe(failure);
});

test("required queues accept a concurrent creator only after the queue is observable", async () => {
  const firstQueue = QUEUE_NAMES[0];
  if (!firstQueue) throw new Error("queue definitions missing");
  const boss = fakeBoss({
    createQueue: async (name) => {
      if (name === firstQueue) throw new Error("already exists");
    },
    afterCreateFailureQueues: [firstQueue],
  });

  await expect(ensureBossQueues(boss)).resolves.toBeUndefined();
});

test("queues beyond the first page of the inventory are not created again", async () => {
  const names = [
    ...Array.from({ length: 1000 }, (_, index) => `aaa.filler.${String(index).padStart(4, "0")}`),
    ...QUEUE_NAMES,
  ].sort();
  const created: string[] = [];
  const boss = {
    getQueues: async (_names?: string[], options?: ListOptions): Promise<QueueResult[]> => {
      const after = options?.after;
      return names
        .filter((name) => after === undefined || name > after)
        .slice(0, options?.limit ?? 1000)
        .map((name) => ({ name }) as QueueResult);
    },
    createQueue: async (name: string) => {
      created.push(name);
    },
  };

  await ensureBossQueues(boss);
  expect(created.filter((name) => (QUEUE_NAMES as readonly string[]).includes(name))).toEqual([]);
});
