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
import { diagnoseWorkflow } from "./gate-diagnosis.ts";
import { normalizeWorkflowRunInput } from "./run-input.ts";

export async function prepareReportAuthority(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
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
  const asking =
    (
      await diagnoseWorkflow(db, input.tenant_id, input.workflow_id, input.execution_environment, {
        version_id: input.workflow_version_id,
      })
    )?.diagnoses.filter((entry) => entry.remedy_kind === "prepare") ?? [];
  const unbound = preview.preparation_required || (preview.manifest?.issues?.length ?? 0) > 0;
  if ((preview.eligible_for_repeated_runs || !unbound) && asking.length === 0)
    return {
      prepared: false,
      reason: preview.eligible_for_repeated_runs ? "already_bindable" : "nothing_to_prepare",
    };
  const replay = input.input === undefined ? await refusedRunInput(db, input, asking) : undefined;
  const start = replay !== undefined ? { input: replay } : await preparationInput(input, db);
  if ("trigger" in start) return start;
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
  const diagnosis = await diagnoseWorkflow(
    db,
    input.tenant_id,
    input.workflow_id,
    input.execution_environment,
    { version_id: input.workflow_version_id },
  );
  const diagnoses = (diagnosis?.diagnoses ?? []).map((entry) => ({
    code: entry.code,
    ...(entry.reason ? { reason: entry.reason } : {}),
    step_id: entry.subject.step_id,
    remedy_kind: entry.remedy_kind,
    ...(entry.fixer ? { fixer: entry.fixer } : {}),
    ...(entry.candidate_id ? { candidate_id: entry.candidate_id } : {}),
  }));
  return diagnoses.length > 0
    ? { prepared: true as const, diagnoses }
    : { prepared: true as const };
}

async function refusedRunInput(
  db: Db,
  input: Parameters<typeof prepareReportAuthority>[0],
  asking: { evidence?: { execution_id?: string } }[],
): Promise<unknown> {
  const ids = asking.flatMap((entry) =>
    entry.evidence?.execution_id ? [entry.evidence.execution_id] : [],
  );
  if (ids.length === 0) return undefined;
  const [run] = await db
    .select({ input: executions.input })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, input.tenant_id),
        eq(executions.workflow_id, input.workflow_id),
        eq(executions.workflow_version_id, input.workflow_version_id),
        eq(executions.execution_mode, input.execution_environment),
        inArray(executions.id, ids),
        isNotNull(executions.input),
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(1);
  return run?.input ?? undefined;
}

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
  if (schedules.length > 1)
    throw Object.assign(new Error("Review one schedule at a time"), {
      code: "authority_preparation_ambiguous",
    });
  if (schedules[0]) return { input: schedules[0].input ?? {} };
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
