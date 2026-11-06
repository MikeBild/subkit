import { eq } from "drizzle-orm";
import { executionSteps, executions } from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import type { WorkflowDef } from "../types.ts";

export const CONNECTOR = "00000000-0000-4000-8000-000000000001";

export const definition = (steps: unknown[]): WorkflowDef =>
  ({ name: "Proposal", steps }) as unknown as WorkflowDef;

export function boundaryProposalFixtures(state: {
  readonly ctx: TestDb;
  readonly workflow_id: string;
  readonly tenant_id: string;
}) {
  async function record(
    rows: Array<{
      step: string;
      url?: string;
      key?: string;
      prefix?: string;
      bytes?: number;
      refused?: true;
    }>,
  ) {
    await state.ctx.db.delete(executions).where(eq(executions.workflow_id, state.workflow_id));
    const [execution] = await state.ctx.db
      .insert(executions)
      .values({
        tenant_id: state.tenant_id,
        workflow_id: state.workflow_id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
      })
      .returning();
    await state.ctx.db.insert(executionSteps).values(
      rows.map((row, index) => ({
        tenant_id: state.tenant_id,
        execution_id: execution?.id as string,
        step_key: row.step,
        step_index: index,
        kind: "request" as const,
        status: row.refused ? ("failed" as const) : ("succeeded" as const),
        request_meta: {
          driver: row.key || row.prefix ? "s3" : "http",
          ...(row.url ? { url: row.url } : {}),
          ...(row.key ? { key: row.key } : {}),
          ...(row.prefix ? { prefix: row.prefix } : {}),
          ...(row.bytes ? { bytes_out: row.bytes } : {}),
          ...(row.refused ? { refused: true } : {}),
        },
      })),
    );
  }

  return { record };
}
