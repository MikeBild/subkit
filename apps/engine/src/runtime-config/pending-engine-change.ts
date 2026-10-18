import { eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { runtimeConfigState } from "../db/schema/index.ts";
import { CONFIG_STATE_KEY, RuntimeConfigPendingError } from "./contracts.ts";

export async function assertNoPendingEngineChange(db: Executor): Promise<void> {
  // tenant-filter:exempt — the canonical active/desired pointer is product-global.
  const [state] = await db
    .select()
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (!state?.active_revision) return;
  if ((state.desired_revision ?? state.active_revision) !== state.active_revision) {
    throw new RuntimeConfigPendingError();
  }
}
