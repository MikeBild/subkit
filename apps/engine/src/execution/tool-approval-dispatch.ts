import { isDeepStrictEqual } from "node:util";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { RequestDispatchPolicy } from "../connectors/drivers/http.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Db } from "../db/client.ts";
import {
  credentials,
  executionSteps,
  executions,
  toolApprovals,
  workflows,
} from "../db/schema/index.ts";
import { decryptPreview } from "../tools/approval-portal.ts";
import { preparedInputDigest } from "../tools/prepared-workflow-approval.ts";
import { authorityConnectorDigest } from "../workflows/authority-configuration.ts";
import { PreparedDispatchSnapshotSchema, preparedRequestProof } from "./prepared-request.ts";
import type { RequestAuthoritySnapshot } from "./types.ts";

class PreparedDispatchDenied extends Error {
  constructor(readonly code: string) {
    super("The prepared external action requires a new decision.");
  }
}
function denied(reason: string): never {
  throw new PreparedDispatchDenied(reason);
}

/** Charge each outbound attempt before dispatch. The row lock serializes
 * parallel steps and a stored counter survives queue/process recovery. */
export async function assertToolApprovalDispatch(
  db: Db,
  tenant: string,
  executionId: string,
  snapshot?: RequestAuthoritySnapshot,
): Promise<RequestDispatchPolicy> {
  return db
    .transaction(async (tx): Promise<RequestDispatchPolicy> => {
      if (snapshot && !PreparedDispatchSnapshotSchema.safeParse(snapshot).success)
        denied("prepared_effect_unknown");
      const [run] = await tx
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, tenant), eq(executions.id, executionId)))
        .for("update")
        .limit(1);
      if (
        !run?.tool_approval_id ||
        !run.workflow_id ||
        run.abort_requested_at ||
        !["queued", "running"].includes(run.status)
      )
        denied("tool_approval_unavailable");
      const [decision] = await tx
        .select({ approval: toolApprovals, workflow: workflows })
        .from(toolApprovals)
        .innerJoin(
          workflows,
          and(eq(workflows.id, run.workflow_id), eq(workflows.tenant_id, tenant)),
        )
        .where(
          and(
            eq(toolApprovals.tenant_id, tenant),
            eq(toolApprovals.id, run.tool_approval_id),
            isNotNull(toolApprovals.granted_at),
            isNotNull(toolApprovals.consumed_at),
            isNull(toolApprovals.declined_at),
            sql`${toolApprovals.expires_at} > clock_timestamp()`,
            eq(workflows.lifecycle, "active"),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      if (!decision) denied("tool_approval_unavailable");
      const approval = decision.approval;
      if (approval.claimed_execution_id && approval.claimed_execution_id !== run.id)
        denied("tool_approval_already_bound");
      const binding = decryptPreview(approval)?.prepared_workflow;
      if (
        !binding ||
        !binding.request_proofs ||
        binding.workflow_id !== run.workflow_id ||
        binding.workflow_version_id !== run.workflow_version_id ||
        decision.workflow.current_version_id !== binding.workflow_version_id ||
        binding.execution_mode !== run.execution_mode ||
        approval.execution_mode !== run.execution_mode ||
        binding.input_digest !== preparedInputDigest(run.input) ||
        (snapshot && snapshot.principal_id !== approval.principal_id)
      )
        denied("prepared_effect_changed");
      if (!approval.claimed_execution_id) {
        const [bound] = await tx
          .update(toolApprovals)
          .set({ claimed_execution_id: run.id })
          .where(
            and(
              eq(toolApprovals.tenant_id, tenant),
              eq(toolApprovals.id, approval.id),
              isNull(toolApprovals.claimed_execution_id),
            ),
          )
          .returning({ id: toolApprovals.id });
        if (!bound) denied("tool_approval_already_bound");
        await auditAwait(
          {
            tenant_id: tenant,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.APPROVAL_EXECUTION_BOUND,
            resource_type: "execution",
            resource_id: run.id,
            result: "success",
            metadata: { approval_id: approval.id, request_source: run.request_source },
          },
          tx,
        );
      }
      if (!snapshot) return { redirect: "manual" };
      if (snapshot.requires_review === false) return { redirect: "manual" };
      if (!snapshot.request || !snapshot.step_row_id || !snapshot.request_max_attempts)
        denied("prepared_effect_unknown");
      const proof = preparedRequestProof(
        tenant,
        snapshot,
        snapshot.request,
        snapshot.request_max_attempts,
      );
      if (!proof) denied("prepared_effect_unknown");
      const [step] = await tx
        .select({ key: executionSteps.step_key })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, tenant),
            eq(executionSteps.execution_id, run.id),
            eq(executionSteps.id, snapshot.step_row_id),
            eq(executionSteps.status, "running"),
          ),
        )
        .limit(1);
      if (!step) denied("prepared_step_unavailable");
      const matches = binding.request_proofs.filter(
        (candidate) =>
          candidate.digest === proof.digest &&
          candidate.max_attempts === proof.max_attempts &&
          candidate.step_key === step.key,
      );
      if (!matches.length) denied("prepared_request_changed");
      if (snapshot.connector_id) {
        const system = await loadConnectorSystem(
          tenant,
          snapshot.connector_id,
          run.execution_mode,
          tx,
        );
        if (!system || authorityConnectorDigest(system.connector) !== snapshot.configuration_digest)
          denied("prepared_connector_changed");
        if (snapshot.credential_id !== null || system.connector.auth_type !== "none") {
          const metadata = await system.getAuthorityMetadata();
          if (
            !metadata.available ||
            metadata.binding.primary?.id !== snapshot.credential_id ||
            metadata.binding.primary?.revision !== snapshot.credential_revision ||
            !isDeepStrictEqual(
              metadata.binding.connection
                ? {
                    id: metadata.binding.connection.id,
                    revision: metadata.binding.connection.revision,
                  }
                : null,
              snapshot.connection_authority,
            )
          )
            denied("prepared_credential_changed");
        }
      }
      for (const reference of snapshot.referenced_authorities ?? []) {
        const system = await loadConnectorSystem(
          tenant,
          reference.connector_id,
          run.execution_mode,
          tx,
        );
        if (
          !system ||
          authorityConnectorDigest(system.connector) !== reference.configuration_digest
        )
          denied("prepared_reference_connector_changed");
        if (reference.credential_id) {
          const [credential] = await tx
            .select({ revision: credentials.authority_revision })
            .from(credentials)
            .where(
              and(
                eq(credentials.tenant_id, tenant),
                eq(credentials.id, reference.credential_id),
                eq(credentials.connector_id, reference.connector_id),
                eq(credentials.environment, run.execution_mode),
                isNull(credentials.deleted_at),
              ),
            )
            .limit(1);
          if (!credential || credential.revision !== reference.credential_revision)
            denied("prepared_reference_credential_changed");
        }
      }
      const attempts = run.tool_approval_dispatches;
      const previous = attempts[snapshot.step_row_id];
      if (
        previous
          ? previous.digest !== proof.digest ||
            previous.step_key !== step.key ||
            previous.attempts >= proof.max_attempts
          : Object.values(attempts).filter(
              (entry) => entry.digest === proof.digest && entry.step_key === step.key,
            ).length >= matches.length
      )
        denied("prepared_effect_exhausted");
      await tx
        .update(executions)
        .set({
          tool_approval_dispatches: {
            ...attempts,
            [snapshot.step_row_id]: {
              digest: proof.digest,
              step_key: step.key,
              attempts: (previous?.attempts ?? 0) + 1,
            },
          },
        })
        .where(and(eq(executions.tenant_id, tenant), eq(executions.id, run.id)));
      await auditAwait(
        {
          tenant_id: tenant,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.APPROVAL_DISPATCH_RESERVED,
          resource_type: "execution",
          resource_id: run.id,
          result: "success",
          metadata: {
            approval_id: approval.id,
            step_id: snapshot.step_id,
            attempt: (previous?.attempts ?? 0) + 1,
            max_attempts: proof.max_attempts,
            request_source: run.request_source,
          },
        },
        tx,
      );
      return { redirect: "manual" };
    })
    .catch(async (error: unknown) => {
      if (error instanceof PreparedDispatchDenied) {
        const [run] = await db
          .select({ source: executions.request_source, approval: executions.tool_approval_id })
          .from(executions)
          .where(and(eq(executions.tenant_id, tenant), eq(executions.id, executionId)))
          .limit(1);
        if (run)
          await auditAwait(
            {
              tenant_id: tenant,
              actor_type: "system",
              actor_id: null,
              action: AuditAction.APPROVAL_DISPATCH_DENIED,
              resource_type: "execution",
              resource_id: executionId,
              result: "denied",
              reason: error.code,
              metadata: { approval_id: run.approval, request_source: run.source },
            },
            db,
          );
      }
      throw error;
    });
}

/** A reservation precedes network dispatch; a failed attempt may have reached
 * the remote. Never report failure as proof that no external write occurred. */
export async function approvedDispatchOutcome(db: Db, tenant: string, executionId: string) {
  const [run] = await db
    .select({
      dispatches: executions.tool_approval_dispatches,
      status: executions.status,
      approval_id: executions.tool_approval_id,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant), eq(executions.id, executionId)))
    .limit(1);
  if (!run) throw new Error("Approved execution outcome is unavailable");
  const [approval] = run.approval_id
    ? await db
        .select()
        .from(toolApprovals)
        .where(and(eq(toolApprovals.tenant_id, tenant), eq(toolApprovals.id, run.approval_id)))
        .limit(1)
    : [];
  const planned = approval
    ? decryptPreview(approval)?.prepared_workflow?.request_proofs?.length
    : undefined;
  const attempts = Object.entries(run.dispatches);
  const steps = await db
    .select({ id: executionSteps.id, status: executionSteps.status })
    .from(executionSteps)
    .where(and(eq(executionSteps.tenant_id, tenant), eq(executionSteps.execution_id, executionId)));
  const completed = attempts.filter(([id]) =>
    steps.some((step) => step.id === id && step.status === "succeeded"),
  ).length;
  return {
    writes_executed: completed > 0 ? true : attempts.length === 0 ? false : null,
    write_outcome:
      attempts.length === 0
        ? "not_dispatched"
        : completed === planned &&
            run.status === "succeeded" &&
            !steps.some((step) => ["failed", "aborted", "timed_out"].includes(step.status))
          ? "completed"
          : completed > 0
            ? "partially_completed"
            : "unknown",
    write_attempts_reserved: attempts.reduce((total, [, entry]) => total + entry.attempts, 0),
  };
}
