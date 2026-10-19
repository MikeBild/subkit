import { isDeepStrictEqual } from "node:util";
import { z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { RequestDispatchPolicy } from "../connectors/drivers/http.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  executions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { assertTenantActive } from "../identity/self-service.ts";
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
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { assertReadPath } from "../workflows/read-path-boundary.ts";
import { assertReadQuery, assertReportDelivery } from "../workflows/report-delivery-boundary.ts";
import { reportBoundariesFromManifest } from "../workflows/report-delivery-proposal.ts";
import { assertRequestBoundary } from "../workflows/request-boundary.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { assertStorageRequest } from "../workflows/storage-boundary.ts";
import { executableDefinition } from "../workflows/stored-definition.ts";
import { JsonValueSchema } from "../workflows/types.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { bindCallerBudget, reserveCallerBudget } from "./caller-budget.ts";
import { assertCallerMatches, type CallerContext } from "./caller-context.ts";
import { type CallerOrigin, resolveExecutionCallerOrigin } from "./caller-origin.ts";
import { validateAgainstJsonSchema } from "./engine/envelope.ts";
import { resolveDefinition } from "./resolve-definition.ts";
import { recoverExecutionPayload } from "./sensitive-payload.ts";
import { createExecution } from "./state.ts";
import { assertToolApprovalDispatch } from "./tool-approval-dispatch.ts";
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

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export async function admitAuthorizedWorkflowExecution(
  raw: unknown,
  db: Executor,
  caller: CallerContext | null = null,
  authorization: import("./authorization-context.ts").ExecutionAuthorizationContext | null = null,
  callerOrigin: CallerOrigin = caller ? "principal" : "unknown",
) {
  const input = admissionSchema.parse(raw);
  const origin = resolveExecutionCallerOrigin(input.tenant_id, caller, callerOrigin);
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, input.tenant_id);
    await assertTenantActive(input.tenant_id, tx);
    if (input.idempotency_key) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenant_id}:${input.idempotency_key}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, input.tenant_id),
            eq(executions.idempotency_key, input.idempotency_key),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.workflow_id !== input.workflow_id || !existing.workflow_version_id)
          fail(
            "execution_boundary_mismatch",
            "the idempotency key belongs to a different execution boundary",
          );
        const pinned = await resolveDefinition(tx, input.tenant_id, {
          kind: "saved",
          workflow_id: input.workflow_id,
          version_id: existing.workflow_version_id,
        });
        const normalized = JsonValueSchema.parse(
          normalizeWorkflowRunInput(input.input, pinned.def.input_schema) ?? null,
        );
        if (
          !existing.execution_authority_id ||
          existing.workflow_id !== input.workflow_id ||
          (input.workflow_version_id &&
            input.workflow_version_id !== existing.workflow_version_id) ||
          (input.execution_authority_id &&
            input.execution_authority_id !== existing.execution_authority_id) ||
          existing.execution_mode !== input.execution_environment ||
          (existing.parent_execution_id ?? null) !== (input.parent_execution_id ?? null) ||
          !isDeepStrictEqual(existing.caller_context, caller) ||
          existing.caller_origin !== origin ||
          !isDeepStrictEqual(
            recoverExecutionPayload(existing.input, input.tenant_id, existing.id),
            normalized,
          )
        )
          fail(
            "execution_boundary_mismatch",
            "the idempotency key belongs to a different execution boundary",
          );
        return {
          execution_id: existing.id,
          execution_authority_id: existing.execution_authority_id,
          workflow_version_id: existing.workflow_version_id!,
          status: existing.status,
          input: normalized,
          replayed: true,
        };
      }
    }
    const workflow = await lockWorkflowForVersionWrite(tx, input.tenant_id, input.workflow_id);
    if (
      workflow?.lifecycle !== "active" ||
      !workflow.current_version_id ||
      (input.workflow_version_id && input.workflow_version_id !== workflow.current_version_id)
    )
      fail("workflow_version_not_active", "only the exact active workflow version can be admitted");
    const [version] = await tx
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, input.tenant_id),
          eq(workflowVersions.workflow_id, input.workflow_id),
          eq(workflowVersions.id, workflow.current_version_id),
        ),
      )
      .for("share")
      .limit(1);
    if (!version) fail("workflow_version_not_active", "active workflow version unavailable");
    const definition = executableDefinition(version.dag);
    const normalized = JsonValueSchema.parse(
      normalizeWorkflowRunInput(input.input, definition.input_schema) ?? null,
    );
    if (input.request_source === "chat" && definition.execution_privacy === "sensitive")
      fail(
        "sensitive_execution_unsupported",
        "Sensitive execution is unavailable on conversation surfaces.",
      );
    assertCallerMatches(
      caller,
      input.tenant_id,
      definition.product_id,
      definition.required_caller_kind,
    );
    if (definition.input_schema) {
      const check = validateAgainstJsonSchema(normalized, definition.input_schema, "$input");
      if (!check.valid) fail("input_schema_violation", check.errors.join("; "));
    }
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: input.tenant_id,
        workflow_id: input.workflow_id,
        workflow_version_id: workflow.current_version_id,
        execution_environment: input.execution_environment,
      },
      tx,
    );
    if (!preview.eligible_for_repeated_runs)
      fail(
        "execution_authority_required",
        "this workflow requires concrete-run review for its current effects",
      );
    const [authority] = await tx
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
          eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
          eq(workflowExecutionAuthorities.workflow_version_id, workflow.current_version_id),
          eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
          input.execution_authority_id
            ? eq(workflowExecutionAuthorities.id, input.execution_authority_id)
            : eq(workflowExecutionAuthorities.effect_manifest_digest, preview.digest),
          authorityLive(),
        ),
      )
      .orderBy(desc(workflowExecutionAuthorities.created_at), desc(workflowExecutionAuthorities.id))
      .for("update")
      .limit(1);
    if (!authority)
      fail(
        "execution_authority_unavailable",
        "no matching live execution authority has runs remaining",
      );
    if (authority.effect_manifest_digest !== preview.digest)
      fail(
        "execution_authority_changed",
        "the execution authority no longer matches the current effect boundary",
      );
    const reservation = await reserveCallerBudget(tx, definition, caller, normalized);
    const execution_id = await createExecution(tx, {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      workflow_version_id: workflow.current_version_id,
      execution_authority_id: authority.id,
      execution_mode: input.execution_environment,
      source_kind: "saved",
      source_ref: input.parent_execution_id ? { rerun_of: input.parent_execution_id } : null,
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
      execution_authority_id: authority.id,
      workflow_version_id: workflow.current_version_id,
      status: "queued" as const,
      input: normalized,
      replayed: false,
    };
  });
}

export function admitSystemWorkflowExecution(raw: unknown, db: Executor) {
  return admitAuthorizedWorkflowExecution(raw, db, null, null, "trusted_system");
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
  for (const row of governing) {
    if (row.abort_requested_at || !["queued", "running"].includes(row.status))
      fail(
        "execution_boundary_mismatch",
        "the authorized execution is cancelled or already terminal",
      );
  }
  const [authority] = await db
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
        eq(workflowExecutionAuthorities.id, authorityId),
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
  return { redirect: "manual" };
}
