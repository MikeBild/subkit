import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeConfigState } from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "./contracts.ts";

export const runtimeStateColumns = {
  key: runtimeConfigState.key,
  active_revision: runtimeConfigState.active_revision,
  desired_revision: runtimeConfigState.desired_revision,
  updated_at: runtimeConfigState.updated_at,
};

export async function ensureRuntimeState(db: Executor): Promise<void> {
  await db.execute(
    sql`INSERT INTO ${runtimeConfigState}(key) VALUES(${CONFIG_STATE_KEY}) ON CONFLICT(key) DO NOTHING`,
  );
}
