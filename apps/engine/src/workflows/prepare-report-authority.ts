import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { executions, webhooksInbound } from "../db/schema/index.ts";
import { validateAgainstJsonSchema } from "../execution/engine/envelope.ts";
import { runExecution } from "../execution/engine.ts";
import { resolveDefinition } from "../execution/resolve-definition.ts";
import { createExecution } from "../execution/state.ts";
import { listSchedules } from "../scheduler/repo.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import { normalizeWorkflowRunInput } from "./run-input.ts";

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
 * The held run needs the input a real start would give it. A schedule carries
 * its own; a webhook's input is a delivery, and a refused delivery is not kept.
 * For a hook-started workflow the reviewer's sample wins; without one the
 * newest admitted delivery serves, and only when there is none either is the
 * answer `input_required` — a run over `{}` observes a workflow that never runs
 * that way, and its evidence describes nothing. The delivery itself never
 * appears in the answer.
 *
 * This cannot activate a version, send a message or create an execution grant.
 */
export async function prepareReportAuthority(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
    /** A sample of what really starts this workflow, supplied by the reviewer. */
    input?: unknown;
  },
  db: Db,
  principal: ResolvedPrincipal,
) {
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      workflow_version_id: input.workflow_version_id,
      execution_environment: input.execution_environment,
    },
    db,
  );
  if (preview.eligible_for_repeated_runs) return { prepared: false, reason: "already_bindable" };
  // A held run helps whenever something is unbound: the report profile asks for
  // it by name, and every other refused step needs exactly the same evidence.
  if (!preview.preparation_required && (preview.manifest?.issues?.length ?? 0) === 0)
    return { prepared: false, reason: "nothing_to_prepare" };
  const start = await preparationInput(input, db);
  if ("trigger" in start) return start;
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
      input: start.input,
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
    input: start.input,
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

/**
 * The one input both the execution row and the run receive: the reviewer's
 * sample, else the single schedule's, else the newest admitted delivery of the
 * hook that starts this workflow, else — only when no hook starts it — an empty
 * one.
 */
async function preparationInput(
  input: Parameters<typeof prepareReportAuthority>[0],
  db: Db,
): Promise<
  | { input: unknown }
  | {
      prepared: false;
      reason: "input_required";
      trigger: { kind: "inbound_hook"; slug: string };
    }
> {
  if (input.input !== undefined) {
    const supplied = normalizeWorkflowRunInput(input.input);
    // Refused here, not by the run: the run would already own an execution row.
    const { def } = await resolveDefinition(db, input.tenant_id, {
      kind: "saved",
      workflow_id: input.workflow_id,
      version_id: input.workflow_version_id,
    });
    if (def.input_schema) {
      const check = validateAgainstJsonSchema(supplied, def.input_schema, "$input");
      if (!check.valid)
        throw Object.assign(new Error(check.errors.join("; ")), {
          code: "input_schema_violation",
        });
    }
    return { input: supplied };
  }
  const schedules = (await listSchedules(db, input.tenant_id, input.workflow_id)).rows.filter(
    (row) => row.execution_mode === input.execution_environment && !row.paused,
  );
  // Multiple distinct inputs need separate previews. Never silently pick one.
  if (schedules.length > 1)
    throw Object.assign(new Error("Review one schedule at a time"), {
      code: "authority_preparation_ambiguous",
    });
  if (schedules[0]) return { input: schedules[0].input ?? {} };
  // Hooks deliver to production only; a dev preparation has no delivery to wait for.
  if (input.execution_environment === "prod") {
    const [hook] = await db
      .select({ slug: webhooksInbound.slug })
      .from(webhooksInbound)
      .where(
        and(
          eq(webhooksInbound.tenant_id, input.tenant_id),
          eq(webhooksInbound.workflow_id, input.workflow_id),
          eq(webhooksInbound.active, true),
        ),
      )
      .orderBy(webhooksInbound.slug)
      .limit(1);
    if (hook) {
      const admitted = await latestAdmittedDelivery(input, db);
      if (admitted !== undefined) return { input: admitted };
      return {
        prepared: false,
        reason: "input_required",
        trigger: { kind: "inbound_hook", slug: hook.slug },
      };
    }
  }
  return { input: {} };
}

/**
 * The newest delivery the engine admitted for this workflow, when it still fits
 * the version under review.
 *
 * Only admitted deliveries leave an execution row (`admitWebhookExecution`); a
 * refused one is audited and dropped, so this can never resurrect a payload the
 * gate turned away. Any version of the workflow counts — the version under
 * review is usually the new one that has not admitted anything yet — but the
 * sample must satisfy THIS version's input schema. One that no longer does is
 * not an error the reviewer caused: the answer falls back to asking for a
 * sample rather than refusing the preparation.
 */
async function latestAdmittedDelivery(
  input: Parameters<typeof prepareReportAuthority>[0],
  db: Db,
): Promise<unknown | undefined> {
  const [row] = await db
    .select({ input: executions.input })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.execution_mode, "prod"),
        eq(executions.request_source, "webhook"),
        isNotNull(executions.input),
      ),
    )
    .orderBy(desc(executions.created_at), desc(executions.id))
    .limit(1);
  if (!row) return undefined;
  const sample = row.input;
  const { def } = await resolveDefinition(db, input.tenant_id, {
    kind: "saved",
    workflow_id: input.workflow_id,
    version_id: input.workflow_version_id,
  });
  if (def.input_schema && !validateAgainstJsonSchema(sample, def.input_schema, "$input").valid)
    return undefined;
  return sample;
}
