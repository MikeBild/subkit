// Unit test for `scheduleCron`'s pg-boss FK invariant: the queue must
// exist before the schedule row is upserted. Production deploy of
// v4.12.3 surfaced this gap — the reconciler logged `Queue
// wf-schedule:... not found` plus `schedule_name_fkey` violations
// every minute because `boss.schedule()` was called against a
// queue that had never been created.

import { describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import { scheduleCron } from "../cron.ts";

interface StubCall {
  kind: "createQueue" | "schedule";
  name: string;
  cron?: string;
}

function createStubBoss(opts: { onCreateQueue?: () => Promise<void> | void }): {
  boss: PgBoss;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const boss = {
    createQueue: async (name: string) => {
      calls.push({ kind: "createQueue", name });
      await opts.onCreateQueue?.();
      return undefined;
    },
    schedule: async (name: string, cron: string) => {
      calls.push({ kind: "schedule", name, cron });
      return undefined;
    },
    unschedule: async () => undefined,
    send: async () => "stub-job",
    getQueues: async () => [],
    on: () => undefined,
  } as unknown as PgBoss;
  return { boss, calls };
}

describe("scheduleCron", () => {
  test("creates the pg-boss queue before scheduling (FK satisfiable)", async () => {
    const { boss, calls } = createStubBoss({});
    await scheduleCron({
      boss,
      name: "wf-schedule:test-1",
      cron: "0 19 * * *",
      tz: "Europe/Berlin",
    });
    expect(calls).toEqual([
      { kind: "createQueue", name: "wf-schedule:test-1" },
      { kind: "schedule", name: "wf-schedule:test-1", cron: "0 19 * * *" },
    ]);
  });

  test("swallows the duplicate-key error from createQueue when the queue exists", async () => {
    const { boss, calls } = createStubBoss({
      onCreateQueue: async () => {
        throw new Error('duplicate key value violates unique constraint "queue_pkey"');
      },
    });
    // Must not throw — the duplicate is the steady-state on the
    // reconciler's per-minute loop.
    await scheduleCron({
      boss,
      name: "wf-schedule:test-2",
      cron: "0 19 * * *",
    });
    expect(calls[0]?.kind).toBe("createQueue");
    expect(calls[1]?.kind).toBe("schedule");
  });

  test("rethrows non-duplicate createQueue errors", async () => {
    const { boss } = createStubBoss({
      onCreateQueue: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    });
    await expect(
      scheduleCron({
        boss,
        name: "wf-schedule:test-3",
        cron: "0 19 * * *",
      }),
    ).rejects.toThrow(/connection terminated/);
  });

  test("skips queue creation entirely for `every:N` cadences", async () => {
    const { boss, calls } = createStubBoss({});
    await scheduleCron({
      boss,
      name: "wf-schedule:test-4",
      cron: "every:5",
    });
    // every:N is handled by the reconciler's setInterval — pg-boss
    // never sees a queue or a schedule for it.
    expect(calls).toEqual([]);
  });
});
