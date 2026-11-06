import type { PgBoss } from "pg-boss";

export interface SendCall {
  queue: string;
  payload: unknown;
}

export function createStubBoss(
  calls: SendCall[],
  ignoredQueues: ReadonlySet<string> = new Set(),
): PgBoss {
  return {
    send: async (queue: string, payload: unknown) => {
      if (!ignoredQueues.has(queue)) calls.push({ queue, payload });
      return "stub-job-id";
    },
    schedule: async () => undefined,
    unschedule: async () => undefined,
    getQueues: async () => [],
    createQueue: async () => undefined,
    on: () => undefined,
  } as unknown as PgBoss;
}
