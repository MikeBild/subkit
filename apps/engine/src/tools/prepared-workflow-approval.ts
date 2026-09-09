import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { executions, workflows } from "../db/schema/index.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";

/** Version/input provenance only; this does not claim connector/effect binding. */
export const PreparedWorkflowBindingSchema = z
  .object({
    schema_version: z.literal(1),
    execution_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid(),
    execution_mode: z.enum(["dev", "prod"]),
    input_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type PreparedWorkflowBinding = z.infer<typeof PreparedWorkflowBindingSchema>;

export function preparedInputDigest(input: unknown): string {
  return workflowJsonDigest(input ?? {});
}

/** Derive provenance from the completed held run, never the latest workflow or
 * a model-supplied version. This internal parameter is not a public tool input. */
export async function capturePreparedWorkflowBinding(p: {
  db: Db;
  tenant_id: string;
  execution_id: string;
  tool: string;
  execution_mode: "dev" | "prod" | null;
  args: Record<string, unknown>;
}): Promise<PreparedWorkflowBinding> {
  const [row] = await p.db
    .select({ execution: executions, slug: workflows.slug })
    .from(executions)
    .innerJoin(
      workflows,
      and(eq(workflows.id, executions.workflow_id), eq(workflows.tenant_id, executions.tenant_id)),
    )
    .where(and(eq(executions.tenant_id, p.tenant_id), eq(executions.id, p.execution_id)))
    .limit(1);
  const run = row?.execution;
  if (
    run?.source_kind !== "saved" ||
    !run.hold_writes ||
    run.status !== "succeeded" ||
    run.abort_requested_at ||
    !run.workflow_id ||
    !run.workflow_version_id ||
    p.tool !== `wf_${row?.slug}` ||
    run.execution_mode !== p.execution_mode ||
    preparedInputDigest(run.input) !== preparedInputDigest(p.args)
  ) {
    throw new Error("Prepared workflow approval does not match a completed held execution");
  }
  return PreparedWorkflowBindingSchema.parse({
    schema_version: 1,
    execution_id: run.id,
    workflow_id: run.workflow_id,
    workflow_version_id: run.workflow_version_id,
    execution_mode: run.execution_mode,
    input_digest: preparedInputDigest(run.input),
  });
}

export function preparedWorkflowMatches(
  binding: PreparedWorkflowBinding | null | undefined,
  target: {
    workflow_id: string;
    workflow_version_id: string | null;
    execution_mode: "dev" | "prod" | null;
    args: Record<string, unknown>;
  },
): binding is PreparedWorkflowBinding {
  return (
    !!binding &&
    binding.workflow_id === target.workflow_id &&
    binding.workflow_version_id === target.workflow_version_id &&
    binding.execution_mode === target.execution_mode &&
    binding.input_digest === preparedInputDigest(target.args)
  );
}
