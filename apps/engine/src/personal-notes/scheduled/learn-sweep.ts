import type { PgBoss } from "pg-boss";
import type { Db } from "../../db/index.ts";
import { enqueuePersonalNotesLearn, logLearnEnqueueFailure } from "../learn.ts";
import { listPeopleWithNewMessages } from "../persistence/messages.ts";

export const SWEEP_MAX_PEOPLE_PER_TENANT = 200;

export async function enqueueLearningForTenant(
  db: Db,
  tenant_id: string,
  enqueue: (job: { tenant_id: string; user_id: string }) => Promise<unknown>,
): Promise<number> {
  const people = await listPeopleWithNewMessages(db, tenant_id, SWEEP_MAX_PEOPLE_PER_TENANT);
  let enqueued = 0;
  for (const user_id of people) {
    try {
      await enqueue({ tenant_id, user_id });
      enqueued += 1;
    } catch (err) {
      logLearnEnqueueFailure(tenant_id, err);
    }
  }
  return enqueued;
}

export async function enqueuePersonalNotesForTenant(
  db: Db,
  boss: PgBoss,
  tenant_id: string,
): Promise<number> {
  return enqueueLearningForTenant(db, tenant_id, (job) => enqueuePersonalNotesLearn(boss, job));
}
