import { and, eq, sql } from "drizzle-orm";
import { type CredentialUseSnapshot, CredentialUseSnapshotSchema } from "../credentials/index.ts";
import type { Executor } from "../db/client.ts";
import { executionSteps } from "../db/schema/index.ts";

export async function appendCredentialSnapshot(
  db: Executor,
  tenant_id: string,
  execution_id: string,
  step_row_id: string,
  snapshot: CredentialUseSnapshot,
): Promise<void> {
  const rows = await db
    .update(executionSteps)
    .set({
      credential_snapshots: sql`${executionSteps.credential_snapshots} || ${JSON.stringify([CredentialUseSnapshotSchema.parse(snapshot)])}::jsonb`,
    })
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.id, step_row_id),
      ),
    )
    .returning({ id: executionSteps.id });
  if (!rows.length) throw new Error("credential snapshot step unavailable");
}
