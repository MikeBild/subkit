import { and, eq, inArray, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executions } from "../db/schema/index.ts";
import { runExecution } from "../execution/engine.ts";
import { createExecution } from "../execution/state.ts";
import { listSchedules } from "../scheduler/repo.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";

/**
 * Run this workflow once with every write held, so the review has something to
 * read.
 *
 * A held run resolves each step's real target and content and records both. For
 * a report that is how the recipient is observed; for any other unbounded step
 * it is the evidence the boundary derivation needs, and for a step that sends
 * content it is the only place its size is written down.
 *
 * It used to run ONLY for the report profile and return silently otherwise —
 * while the endpoint above answered `prepared: true` either way. A reviewer was
 * told the preparation had happened, five workflows produced no run at all, and
 * the derivation that depended on it reported "these steps have never run".
 * The result now says which of the two happened.
 *
 * This cannot activate a version, send a message or create an execution grant.
 */
export async function prepareReportAuthority(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  db: Db,
  principal: ResolvedPrincipal,
) {
  const preview = await previewWorkflowAuthority(input, db);
  if (preview.eligible_for_repeated_runs) return { prepared: false, reason: "already_bindable" };
  // A held run helps whenever something is unbound: the report profile asks for
  // it by name, and every other refused step needs exactly the same evidence.
  if (!preview.preparation_required && (preview.manifest?.issues?.length ?? 0) === 0)
    return { prepared: false, reason: "nothing_to_prepare" };
  const schedules = (await listSchedules(db, input.tenant_id, input.workflow_id)).rows.filter(
    (row) => row.execution_mode === input.execution_environment && !row.paused,
  );
  // Multiple distinct inputs need separate previews. Never silently pick one.
  if (schedules.length > 1)
    throw Object.assign(new Error("Review one schedule at a time"), {
      code: "authority_preparation_ambiguous",
    });
  // One preparation at a time for one version in one environment.
  //
  // The dialog showed a bare "loading" for as long as this takes, and a run
  // that reads several remote systems takes minutes. People opened a second
  // tab, and three held runs started at once against the same workflow — each
  // reading the same remote systems, each writing evidence the others would
  // overwrite. A flag inside the component cannot see a second tab; this can,
  // and it sees a second ENGINE too.
  //
  // The lock is held only while deciding, then released with the transaction.
  // The run itself is deliberately outside it: holding a lock for the length of
  // a six-hour run would turn every later request into a wait rather than an
  // answer. Pre-creating the row inside the lock is what makes the decision
  // stick — the next caller sees a row, not an absence.
  const executionId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepare:${input.tenant_id}:${input.workflow_id}:${input.workflow_version_id}:${input.execution_environment}`}, 0))`,
    );
    const [running] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, input.tenant_id),
          eq(executions.workflow_id, input.workflow_id),
          eq(executions.workflow_version_id, input.workflow_version_id),
          eq(executions.execution_mode, input.execution_environment),
          eq(executions.hold_writes, true),
          inArray(executions.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (running) return null;
    return createExecution(tx, {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_mode: input.execution_environment,
      source_kind: "saved",
      source_ref: null,
      input: schedules[0]?.input ?? {},
      request_source: "ui",
      hold_writes: true,
    });
  });
  // Not an error: opening the dialog twice is ordinary, and a repair reload
  // takes this path routinely. Rendering it red would turn correct behaviour
  // into an alarm.
  if (executionId === null) return { prepared: false, reason: "preparation_in_flight" };
  const result = await runExecution({
    db,
    tenant_id: input.tenant_id,
    source: {
      kind: "saved",
      workflow_id: input.workflow_id,
      version_id: input.workflow_version_id,
    },
    input: schedules[0]?.input ?? {},
    options: {
      existing_execution_id: executionId,
      hold_writes: true,
      execution_mode: input.execution_environment,
      request_source: "ui",
      principal,
      self_healing: { enabled: false },
    },
  });
  if (result.status !== "succeeded")
    throw Object.assign(new Error("The preparation did not complete; external writes were held"), {
      code: "authority_preparation_failed",
    });
  return { prepared: true as const };
}
