// The boot sweep for wait checkpoints that outlived their process.
//
// This path had no test, and that is how it stayed wrong for so long: it
// re-enqueued a job the engine refuses to start and recorded the wait as
// completed and recovered. An operator reading the audit log was told the
// opposite of what happened.
//
// So the assertions here are about the promise, not the plumbing: no job is
// enqueued, the checkpoint is gone, and the trail says the wait was abandoned.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog } from "../db/schema/audit.ts";
import { tenants } from "../db/schema/identity.ts";
import { executions, workflows } from "../db/schema/index.ts";
import { workflowWaits } from "../db/schema/workflow_waits.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW, setTestNow } from "../test-helpers/determinism/clock.ts";
import { reapOrphanedWaits } from "./wait-reaper.ts";

let tdb: TestDb;
let tenantId: string;
let workflowId: string;

/** Records every send so the test can assert that none happens. */
function recordingBoss(): { boss: PgBoss; sends: unknown[] } {
  const sends: unknown[] = [];
  const boss = {
    send: async (...args: unknown[]) => {
      sends.push(args);
      return "job-id";
    },
  } as unknown as PgBoss;
  return { boss, sends };
}

beforeAll(async () => {
  // The sweep reads the clock seam to decide whether a wait was already due,
  // so freezing it makes "overdue" a property of the fixture rather than of
  // when the suite happens to run.
  setTestNow(() => FROZEN_NOW);
  tdb = await createTestDb("execution-wait-reaper");
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "reaper-test", display_name: "Reaper Test" })
    .returning({ id: tenants.id });
  tenantId = tenant!.id;
  const [wf] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "reaper-wf", name: "Reaper WF", lifecycle: "active" })
    .returning({ id: workflows.id });
  workflowId = wf!.id;
});

afterAll(async () => {
  setTestNow(null);
  await tdb.cleanup();
});

beforeEach(async () => {
  await tdb.db.delete(workflowWaits);
  await tdb.db.delete(executions);
  await tdb.db.delete(auditLog);
});

/** A crashed run, exactly as the sweep finds it: still `running`, with a
 *  checkpoint row whose timer died with the process. */
async function seedCheckpoint(sleepUntil: Date): Promise<string> {
  const [execution] = await tdb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflowId,
      status: "running",
      request_source: "test",
      execution_mode: "prod",
    })
    .returning({ id: executions.id });
  const executionId = execution!.id;
  await tdb.db.insert(workflowWaits).values({
    tenant_id: tenantId,
    workflow_id: workflowId,
    execution_id: executionId,
    step_id: "wait-step",
    sleep_until_ts: sleepUntil,
  });
  return executionId;
}

describe("reapOrphanedWaits", () => {
  test("does nothing and reports nothing when there is no checkpoint", async () => {
    const { boss, sends } = recordingBoss();
    const result = await reapOrphanedWaits(tdb.db, boss);
    expect(result.reaped).toBe(0);
    expect(sends).toHaveLength(0);
  });

  test("never re-enqueues the execution", async () => {
    // The re-enqueued job could not start — markExecutionRunning transitions
    // only from `queued`, and a crashed execution is still `running`. Enqueuing
    // it produced an aborted job and a misleading audit entry every boot.
    await seedCheckpoint(new Date(FROZEN_NOW - 60_000));
    const { boss, sends } = recordingBoss();
    await reapOrphanedWaits(tdb.db, boss);
    expect(sends).toHaveLength(0);
  });

  test("clears the checkpoint so the next boot does not report it again", async () => {
    await seedCheckpoint(new Date(FROZEN_NOW - 60_000));
    const { boss } = recordingBoss();
    const first = await reapOrphanedWaits(tdb.db, boss);
    expect(first.reaped).toBe(1);
    expect(await tdb.db.select().from(workflowWaits)).toHaveLength(0);
    const second = await reapOrphanedWaits(tdb.db, boss);
    expect(second.reaped).toBe(0);
  });

  test("records the wait as abandoned, not as completed", async () => {
    const executionId = await seedCheckpoint(new Date(FROZEN_NOW - 60_000));
    const { boss } = recordingBoss();
    await reapOrphanedWaits(tdb.db, boss);

    const rows = await tdb.db.select().from(auditLog).where(eq(auditLog.resource_id, executionId));
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.action).toBe("wait.abandoned");
    expect(entry.action).not.toBe("wait.completed");
    expect(entry.tenant_id).toBe(tenantId);
    expect((entry.metadata as { overdue?: boolean }).overdue).toBe(true);
  });

  test("distinguishes a wait that was due from one still waiting", async () => {
    // The distinction changes what an operator does about it: a wait that had
    // already elapsed was ready to continue, a future one was not.
    const stillWaiting = await seedCheckpoint(new Date(FROZEN_NOW + 3_600_000));
    const { boss } = recordingBoss();
    await reapOrphanedWaits(tdb.db, boss);

    const rows = await tdb.db.select().from(auditLog).where(eq(auditLog.resource_id, stillWaiting));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as { overdue?: boolean }).overdue).toBe(false);
  });

  test("sweeps every orphan, not just the first", async () => {
    await seedCheckpoint(new Date(FROZEN_NOW - 60_000));
    await seedCheckpoint(new Date(FROZEN_NOW - 30_000));
    await seedCheckpoint(new Date(FROZEN_NOW + 60_000));
    const { boss } = recordingBoss();
    const result = await reapOrphanedWaits(tdb.db, boss);
    expect(result.reaped).toBe(3);
    expect(await tdb.db.select().from(workflowWaits)).toHaveLength(0);
  });
});
