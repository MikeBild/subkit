import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowsSchedules } from "../db/schema/index.ts";

/** Only explicit held preparation may inherit an unambiguous saved schedule.
 * An explicit input (including {}) and every live-run request keep their meaning.
 */
export async function workflowPreparationInput(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  environment: "dev" | "prod",
  args: { input?: Record<string, unknown> | undefined; execute_writes?: boolean | undefined },
): Promise<Record<string, unknown> | undefined> {
  if (args.input !== undefined || args.execute_writes !== false) return args.input;
  const rows = await db
    .select({ input: workflowsSchedules.input })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
        eq(workflowsSchedules.execution_mode, environment),
        eq(workflowsSchedules.paused, false),
      ),
    );
  if (rows.length > 1)
    throw Object.assign(
      new Error("Choose the schedule to check; its saved inputs differ by schedule."),
      {
        code: "workflow_preparation_schedule_ambiguous",
      },
    );
  const input = rows[0]?.input;
  if (input == null) return undefined;
  return z.record(z.string(), z.unknown()).parse(input);
}
