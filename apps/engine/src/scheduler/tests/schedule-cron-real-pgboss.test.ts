// Integration test: scheduleCron against a REAL pg-boss instance.
//
// The unit test in `schedule-cron-queue.test.ts` stubs the boss, so it
// only proves the call ordering. The deploy of v4.12.3 / v4.12.4
// surfaced two pg-boss invariants that the unit test could not see:
//
//   1. `Attorney.assertQueueName` rejects `:` (and any char outside
//      `[a-zA-Z0-9_\-./]`). Prior `wf-schedule:<id>` keys passed the
//      `boss.schedule(name, …)` path (no validation) but failed
//      `boss.createQueue(name)` — so the FK from `pgboss.schedule.name`
//      into `pgboss.queue.name` could never be satisfied.
//   2. `boss.schedule(name, …)` rewrites a FK violation into
//      `Queue ${name} not found`. The reconciler logged that message
//      every minute on the v4.12.3 production droplet because the
//      queue did not exist.
//
// This test pins the contract end-to-end so a regression on either
// invariant trips here, not in production.

import { describe, expect, test } from "bun:test";
import { scheduleCron } from "../cron.ts";
import { createSchedulerCtx, type SchedulerTestCtx } from "./setup.ts";

describe("scheduleCron — real pg-boss FK", () => {
  test("registers queue + schedule for a dot-suffixed name (no colons)", async () => {
    const ctx: SchedulerTestCtx = await createSchedulerCtx("cron-real-pgboss");
    try {
      const name = `wf-schedule.${crypto.randomUUID()}`; // allow-random: opaque pg-boss queue identifier, not security
      await scheduleCron({
        boss: ctx.boss,
        name,
        cron: "0 19 * * *",
        tz: "Europe/Berlin",
        payload: { kind: "test" },
      });
      // Use pg-boss' own API to validate state — independent of the
      // FK that the bug was hidden behind.
      const queues = await ctx.boss.getQueues();
      const queue = queues.find((q) => q.name === name);
      expect(queue).toBeDefined();
      const schedules = await ctx.boss.getSchedules();
      const sched = schedules.find((s) => s.name === name);
      expect(sched).toBeDefined();
      expect(sched?.cron).toBe("0 19 * * *");
    } finally {
      await ctx.cleanup();
    }
  });

  test("rejects colon-bearing queue name (regression guard for v4.12.3 deploy crash)", async () => {
    const ctx: SchedulerTestCtx = await createSchedulerCtx("cron-real-pgboss-colon");
    try {
      const badName = `wf-schedule:${crypto.randomUUID()}`; // allow-random: opaque pg-boss queue identifier, not security
      await expect(
        scheduleCron({
          boss: ctx.boss,
          name: badName,
          cron: "0 19 * * *",
          tz: "Europe/Berlin",
        }),
      ).rejects.toThrow(/can only contain|Name/i);
    } finally {
      await ctx.cleanup();
    }
  });
});
