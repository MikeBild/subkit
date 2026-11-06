import { isDeepStrictEqual } from "node:util";
import { z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { RequestDispatchPolicy } from "../connectors/drivers/http.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import { CatalogVocabularyBusyError, waitForCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { assertTenantActive } from "../identity/self-service.ts";
import { DomainRefusal } from "../logging/domain-refusal.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";
import { authorityLive, authorityNotExpired } from "../workflows/authority-live.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import {
  assertContentRelease,
  assertContentRevision,
} from "../workflows/content-publication-boundary.ts";
import {
  contentBoundariesFromManifest,
  loadContentRevisionReceipts,
} from "../workflows/content-publication-proposal.ts";
import { WorkflowEffectManifestSchema } from "../workflows/effect-manifest.ts";
import {
  previewWorkflowAuthority,
  sameBoundaryReplacement,
} from "../workflows/execution-authorities.ts";
import { assertOutboxMessage } from "../workflows/outbox-delivery-boundary.ts";
import { assertReadPath } from "../workflows/read-path-boundary.ts";
import { assertReadQuery, assertReportDelivery } from "../workflows/report-delivery-boundary.ts";
import { reportBoundariesFromManifest } from "../workflows/report-delivery-proposal.ts";
import { assertRequestBoundary } from "../workflows/request-boundary.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { assertStorageRequest } from "../workflows/storage-boundary.ts";
import { executableDefinition } from "../workflows/stored-definition.ts";
import { assertTransactionalMessage } from "../workflows/transactional-delivery-boundary.ts";
import { JsonValueSchema } from "../workflows/types.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { inputSchemaVerdict, lockIdempotentExecution } from "./admission-facts.ts";
import { bindCallerBudget, reserveCallerBudget } from "./caller-budget.ts";
import {
  assertCallerMatches,
  assertExecutionPrivacySupported,
  type CallerContext,
} from "./caller-context.ts";
import { type CallerOrigin, resolveExecutionCallerOrigin } from "./caller-origin.ts";
import { type AdmissionDecision, boundaryOfExecution, decideAdmission } from "./core/admission.ts";
import { resolveLiveSuccessor } from "./live-successor.ts";
import { resolveDefinition } from "./resolve-definition.ts";
import { isSensitivePayload, recoverExecutionPayload } from "./sensitive-payload.ts";
import { createExecution } from "./state.ts";
import { assertToolApprovalDispatch } from "./tool-approval-dispatch.ts";
import {
  mailsReservedWithinDay,
  reserveTransactionalMail,
  transactionalWebhookAvailable,
} from "./transactional-mail.ts";
import type { RequestAuthoritySnapshot } from "./types.ts";

const requestSnapshotSchema = z
  .object({
    step_id: z.string().min(1),
    configuration_digest: z.string().regex(/^[a-f0-9]{64}$/),
    credential_id: z.string().uuid().nullable(),
    credential_revision: z.number().int().positive().nullable(),
    connection_authority: z
      .object({ id: z.string().uuid(), revision: z.number().int().positive() })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (snapshot) =>
      snapshot.credential_id === null
        ? snapshot.credential_revision === null && snapshot.connection_authority === null
        : snapshot.credential_revision !== null,
    "credential snapshot identities must be complete",
  );

const admissionSchema = z
  .object({
    tenant_id: z.string().uuid(),
    workflow_id: z.string().uuid(),
    workflow_version_id: z.string().uuid().optional(),
    execution_authority_id: z.string().uuid().optional(),
    execution_environment: z.enum(["dev", "prod"]),
    request_source: RequestSourceSchema,
    input: JsonValueSchema.optional(),
    idempotency_key: z.string().min(1).max(512).optional(),
    parent_execution_id: z.string().uuid().nullable().optional(),
  })
  .strict();

const HELD_AUTHORITY_CODES = new Set([
  "execution_authority_required",
  "execution_authority_unavailable",
]);

function fail(code: string, message: string): never {
  if (HELD_AUTHORITY_CODES.has(code)) throw new DomainRefusal(code, message);
  throw Object.assign(new Error(message), { code });
}

function enforce(decision: AdmissionDecision): void {
  if (decision.kind === "rejected") fail(decision.code, decision.message);
}

export async function admitAuthorizedWorkflowExecution(
  raw: unknown,
  db: Executor,
  caller: CallerContext | null = null,
  authorization: import("./authorization-context.ts").ExecutionAuthorizationContext | null = null,
  callerOrigin: CallerOrigin = caller ? "principal" : "unknown",
  verifiedWebhookId?: string,
) {
  const input = admissionSchema.parse(raw);
  const origin = resolveExecutionCallerOrigin(input.tenant_id, caller, callerOrigin);
  return retryTransient(
    () =>
      db.transaction(async (tx) => {
        await waitForCatalogVocabulary(tx, input.tenant_id);
        await assertTenantActive(input.tenant_id, tx);
        if (input.idempotency_key) {
          const existing = await lockIdempotentExecution(
            tx,
            input.tenant_id,
            input.idempotency_key,
          );
          if (existing) {
            enforce(
              decideAdmission(input, {
                stage: "replay_candidate",
                workflow_id: existing.workflow_id,
                workflow_version_id: existing.workflow_version_id,
              }),
            );
            const pinnedVersionId = existing.workflow_version_id as string;
            const pinned = await resolveDefinition(tx, input.tenant_id, {
              kind: "saved",
              workflow_id: input.workflow_id,
              version_id: pinnedVersionId,
            });
            const normalized = JsonValueSchema.parse(
              normalizeWorkflowRunInput(input.input, pinned.def.input_schema) ?? null,
            );
            enforce(
              decideAdmission(input, {
                stage: "replay",
                existing: boundaryOfExecution(
                  existing,
                  recoverExecutionPayload(existing.input, input.tenant_id, existing.id),
                ),
                requested: {
                  binding: "authorized",
                  execution_authority_id:
                    input.execution_authority_id ?? existing.execution_authority_id,
                  workflow_id: input.workflow_id,
                  workflow_version_id: input.workflow_version_id ?? pinnedVersionId,
                  execution_mode: input.execution_environment,
                  parent_execution_id: input.parent_execution_id ?? null,
                  caller_context: caller,
                  caller_origin: origin,
                  input: normalized,
                },
              }),
            );
            return {
              execution_id: existing.id,
              execution_authority_id: existing.execution_authority_id,
              workflow_version_id: pinnedVersionId,
              status: existing.status,
              input: normalized,
              replayed: true,
            };
          }
        }
        const workflow = await lockWorkflowForVersionWrite(tx, input.tenant_id, input.workflow_id);
        enforce(
          decideAdmission(input, {
            stage: "active_version",
            lifecycle: workflow?.lifecycle ?? null,
            current_version_id: workflow?.current_version_id ?? null,
          }),
        );
        const currentVersionId = workflow?.current_version_id as string;
        const [version] = await tx
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, input.tenant_id),
              eq(workflowVersions.workflow_id, input.workflow_id),
              eq(workflowVersions.id, currentVersionId),
            ),
          )
          .for("share")
          .limit(1);
        enforce(decideAdmission(input, { stage: "active_definition", found: Boolean(version) }));
        const definition = executableDefinition(version?.dag);
        const normalized = JsonValueSchema.parse(
          normalizeWorkflowRunInput(input.input, definition.input_schema) ?? null,
        );
        assertExecutionPrivacySupported(input.request_source, definition.execution_privacy);
        assertCallerMatches(
          caller,
          input.tenant_id,
          definition.product_id,
          definition.required_caller_kind,
        );
        enforce(
          decideAdmission(input, {
            stage: "input",
            verdict: inputSchemaVerdict(normalized, definition.input_schema),
          }),
        );
        const preview = await previewWorkflowAuthority(
          {
            tenant_id: input.tenant_id,
            workflow_id: input.workflow_id,
            workflow_version_id: currentVersionId,
            execution_environment: input.execution_environment,
          },
          tx,
        );
        enforce(
          decideAdmission(input, {
            stage: "repeated_runs",
            eligible: preview.eligible_for_repeated_runs,
          }),
        );
        const requested = input.execution_authority_id
          ? await sameBoundaryReplacement(tx, input.tenant_id, input.execution_authority_id)
          : null;
        const [authority] = await tx
          .select()
          .from(workflowExecutionAuthorities)
          .where(
            and(
              eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
              eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
              eq(workflowExecutionAuthorities.workflow_version_id, currentVersionId),
              eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
              requested
                ? eq(workflowExecutionAuthorities.id, requested)
                : eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
              authorityLive(),
            ),
          )
          .orderBy(
            desc(workflowExecutionAuthorities.created_at),
            desc(workflowExecutionAuthorities.id),
          )
          .for("update")
          .limit(1);
        enforce(
          decideAdmission(input, {
            stage: "authority",
            authority_digest: authority?.effect_manifest_digest ?? null,
            boundary_digest: preview.digest,
          }),
        );
        const admittedAuthorityId = (authority as { id: string }).id;
        const reservation = await reserveCallerBudget(tx, definition, caller, normalized);
        const execution_id = await createExecution(tx, {
          tenant_id: input.tenant_id,
          workflow_id: input.workflow_id,
          workflow_version_id: currentVersionId,
          execution_authority_id: admittedAuthorityId,
          execution_mode: input.execution_environment,
          source_kind: "saved",
          source_ref:
            verifiedWebhookId && origin === "trusted_system"
              ? { verified_webhook_id: verifiedWebhookId }
              : input.parent_execution_id
                ? { rerun_of: input.parent_execution_id }
                : null,
          input: normalized,
          caller_context: caller,
          caller_origin: origin,
          authorization_context: authorization,
          execution_privacy: definition.execution_privacy,
          request_source: input.request_source,
          parent_execution_id: input.parent_execution_id ?? null,
          idempotency_key: input.idempotency_key ?? null,
        });
        await bindCallerBudget(tx, input.tenant_id, execution_id, reservation);
        return {
          execution_id,
          execution_authority_id: admittedAuthorityId,
          workflow_version_id: currentVersionId,
          status: "queued" as const,
          input: normalized,
          replayed: false,
        };
      }),
    {
      tries: 5,
      startMs: 25,
      maxMs: 200,
      label: "execution_admission_catalog",
      shouldRetry: (error) => error instanceof CatalogVocabularyBusyError,
    },
  );
}

export function admitSystemWorkflowExecution(
  raw: unknown,
  db: Executor,
  verifiedWebhookId?: string,
) {
  return admitAuthorizedWorkflowExecution(raw, db, null, null, "trusted_system", verifiedWebhookId);
}

export async function assertExecutionAuthorityCurrent(
  db: Db,
  tenant_id: string,
  execution_id: string,
  snapshot?: RequestAuthoritySnapshot,
): Promise<RequestDispatchPolicy | undefined> {
  await assertTenantActive(tenant_id, db);
  const [execution] = await db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  if (!execution) fail("execution_boundary_mismatch", "execution unavailable");
  if (
    snapshot?.requires_transactional_authority &&
    (execution.tool_approval_id || !execution.execution_authority_id)
  )
    fail(
      "execution_authority_unavailable",
      "Transactional email requires its reviewed recurring authority",
    );
  if (execution.tool_approval_id)
    return assertToolApprovalDispatch(db, tenant_id, execution_id, snapshot);
  let authorityId = execution.execution_authority_id;
  let path: string[] = [];
  const governing = [execution];
  if (execution.authority_root_execution_id) {
    const [root] = await db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, tenant_id),
          eq(executions.id, execution.authority_root_execution_id),
        ),
      )
      .limit(1);
    if (!root)
      fail("execution_boundary_mismatch", "the approved run this one belongs to is unavailable");
    if (!root.execution_authority_id)
      fail(
        "execution_authority_unavailable",
        "the run this one belongs to holds no execution authority",
      );
    authorityId = root.execution_authority_id;
    path = execution.authority_call_path ?? [];
    governing.push(root);
  }
  if (!authorityId) return;
  let pendingMail:
    | { request_id: string; step_id: string; request_source: "webhook" | "scheduler" }
    | undefined;
  for (const row of governing) {
    if (row.abort_requested_at || !["queued", "running"].includes(row.status))
      fail(
        "execution_boundary_mismatch",
        "the authorized execution is cancelled or already terminal",
      );
  }
  const live = async (id: string) => {
    const [row] = await db
      .select()
      .from(workflowExecutionAuthorities)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowExecutionAuthorities.workflow_id),
          eq(workflows.tenant_id, workflowExecutionAuthorities.tenant_id),
        ),
      )
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenant_id),
          eq(workflowExecutionAuthorities.id, id),
          eq(workflows.lifecycle, "active"),
          isNull(workflows.deleted_at),
          eq(workflows.current_version_id, workflowExecutionAuthorities.workflow_version_id),
          isNull(workflowExecutionAuthorities.revoked_at),
          sql`${workflowExecutionAuthorities.valid_from} <= clock_timestamp()`,
          authorityNotExpired(),
          sql`${workflowExecutionAuthorities.reserved_runs} > 0`,
        ),
      )
      .limit(1);
    return row;
  };
  const authority = await resolveLiveSuccessor(
    authorityId,
    (id) => sameBoundaryReplacement(db, tenant_id, id),
    live,
  );
  if (!authority)
    fail("execution_authority_unavailable", "the reserved execution authority is no longer live");
  const boundary = authority.workflow_execution_authorities;
  if (snapshot !== undefined) {
    const {
      request: _request,
      requires_review: _review,
      step_row_id: _row,
      connector_id: _connector,
      request_max_attempts: _attempts,
      requires_transactional_authority: _transactional,
      outbox_source: outboxSource,
      principal_id: _principal,
      referenced_authorities: referencedAuthorities,
      ...authoritySnapshot
    } = snapshot;
    const parsed = requestSnapshotSchema.safeParse(authoritySnapshot);
    const manifest = WorkflowEffectManifestSchema.safeParse(boundary.effect_manifest);
    const effect =
      parsed.success && manifest.success
        ? manifest.data.effects.find(
            (candidate) =>
              candidate.step_id === parsed.data.step_id &&
              candidate.configuration_digest === parsed.data.configuration_digest &&
              isDeepStrictEqual(candidate.call_path ?? [], path),
          )
        : undefined;
    if (!parsed.success || !effect)
      fail(
        "execution_authority_changed",
        "the loaded request configuration is outside its approved boundary",
      );
    for (const reference of referencedAuthorities ?? []) {
      if (
        reference.connector_id !== effect.connector_id ||
        reference.configuration_digest !== parsed.data.configuration_digest ||
        (reference.credential_id !== null &&
          (reference.credential_id !== parsed.data.credential_id ||
            reference.credential_revision !== parsed.data.credential_revision))
      )
        fail(
          "execution_authority_changed",
          "a placeholder of the request reads a connector outside its approved boundary",
        );
    }
    if (effect.report_delivery) assertReportDelivery(effect.report_delivery, snapshot.request);
    if (effect.transactional_delivery) {
      const provenance = recoverExecutionPayload(
        execution.source_ref,
        tenant_id,
        execution_id,
        "source",
      ) as { verified_webhook_id?: unknown } | null;
      if (
        !isSensitivePayload(execution.input) ||
        execution.request_source !== "webhook" ||
        execution.caller_origin !== "trusted_system" ||
        execution.parent_execution_id ||
        execution.authority_root_execution_id ||
        provenance?.verified_webhook_id !== effect.transactional_delivery.webhook_id ||
        snapshot.request_max_attempts !== 1 ||
        !(await transactionalWebhookAvailable(
          db,
          tenant_id,
          boundary.workflow_id,
          effect.transactional_delivery,
        ))
      )
        fail(
          "execution_authority_changed",
          "Transactional delivery requires its reviewed verified webhook and one dispatch attempt",
        );
      const event = assertTransactionalMessage(
        effect.transactional_delivery,
        recoverExecutionPayload(execution.input, tenant_id, execution_id),
        snapshot.request,
      );
      pendingMail = {
        request_id: event.request_id,
        step_id: effect.step_id,
        request_source: "webhook",
      };
    }
    if (effect.outbox_delivery) {
      if (
        execution.parent_execution_id ||
        execution.authority_root_execution_id ||
        snapshot.request_max_attempts !== 1
      )
        fail(
          "execution_authority_changed",
          "Outbox delivery requires its reviewed recurring authority and one dispatch attempt",
        );
      const message = assertOutboxMessage(
        effect.outbox_delivery,
        boundary.workflow_id,
        outboxSource,
        snapshot.request,
      );
      if (
        (await mailsReservedWithinDay(db, tenant_id, boundary.workflow_id)) >=
        effect.outbox_delivery.max_per_day
      )
        fail(
          "execution_authority_changed",
          "Outbox delivery reached its reviewed daily limit; nothing was sent",
        );
      pendingMail = {
        request_id: message.request_id,
        step_id: effect.step_id,
        request_source: "scheduler",
      };
    }

    if (effect.content_publication?.kind === "content_revision")
      assertContentRevision(effect.content_publication, snapshot.request);
    if (effect.content_publication?.kind === "content_release")
      assertContentRelease(
        effect.content_publication,
        snapshot.request,
        await loadContentRevisionReceipts(db, tenant_id, execution_id),
      );
    if (effect.storage)
      assertStorageRequest(effect.storage, snapshot.request, execution.caller_context ?? null);
    if (effect.boundary) assertRequestBoundary(effect.boundary, snapshot.request);
    if (effect.read_path) assertReadPath(effect.read_path, snapshot.request);
    if (effect.read_query) assertReadQuery(effect.read_query, effect.target, snapshot.request);
    const system = effect.connector_id
      ? await loadConnectorSystem(
          tenant_id,
          effect.connector_id,
          boundary.execution_environment,
          db,
        )
      : null;
    if (parsed.data.credential_id !== null || (system && system.connector.auth_type !== "none")) {
      const metadata = await system?.getAuthorityMetadata();
      if (
        !metadata?.available ||
        workflowJsonDigest(metadata.binding) !== effect.credential_binding_digest ||
        metadata.binding.primary?.id !== parsed.data.credential_id ||
        metadata.binding.primary?.revision !== parsed.data.credential_revision ||
        !isDeepStrictEqual(
          metadata.binding.connection
            ? {
                id: metadata.binding.connection.id,
                revision: metadata.binding.connection.revision,
              }
            : null,
          parsed.data.connection_authority,
        )
      )
        fail(
          "execution_authority_changed",
          "the loaded credential is outside its approved boundary",
        );
    }
  }
  const current = await previewWorkflowAuthority(
    {
      tenant_id,
      workflow_id: boundary.workflow_id,
      workflow_version_id: boundary.workflow_version_id,
      execution_environment: boundary.execution_environment,
    },
    db,
    {
      report_boundaries: reportBoundariesFromManifest(boundary.effect_manifest),
      content_boundaries: contentBoundariesFromManifest(boundary.effect_manifest),
    },
  );
  if (!current.eligible_for_repeated_runs || current.digest !== boundary.effect_manifest_digest)
    fail(
      "execution_authority_changed",
      "the reserved execution no longer matches its approved effect boundary",
    );
  if (pendingMail) {
    const { request_source, ...mail } = pendingMail;
    await reserveTransactionalMail(
      db,
      { tenant_id, workflow_id: boundary.workflow_id, execution_id, ...mail },
      request_source,
    );
  }
  return { redirect: "manual" };
}
