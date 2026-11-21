import type { PgBoss } from "pg-boss";
import { AuditAction, actorType, auditAwait } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { enqueueExecutionRun } from "../../devices/waiting.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import type { ExecutionRunJob } from "../../queue/queues.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ApprovalAuditResource } from "../../tools/approval.ts";
import { gateWorkflowRunRbac, type WorkflowRunRequestSource } from "../../workflows/rbac.ts";
import { auditAdmissionRefusal } from "../admission-audit.ts";
import { assertExecutionAuthorityCurrent } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { finalizeExecution } from "../state.ts";
import type { ExecutionMode, RunResult } from "../types.ts";
import type { WorkflowPermission } from "../workflow-permission.ts";
import { admitWorkflowRun } from "../workflow-run-admission.ts";
import {
  effectiveHoldWrites,
  enqueueFailureMessage,
  finalizesOnEnqueueFailure,
  precheckRunRequest,
  type ReplayedQueuedRun,
  type RunErrorStage,
  type RunRefusal,
  rbacDenial,
  refusalCause,
  refusalFromError,
  refusalIsAudited,
  requiresCurrentAuthority,
  resolveExecutionEnvironment,
  returnsReplay,
} from "./core/run-workflow.ts";

export type { RefusalClass, RunRefusal } from "./core/run-workflow.ts";

export type AdmittedWorkflowRun = Awaited<ReturnType<typeof admitWorkflowRun>>;

interface RunAuthorizationRequest {
  principal: ResolvedPrincipal;
  workflow_id: string;
  via: WorkflowRunRequestSource;
  tool?: string;
  workflow_slug?: string;
  approval?: ApprovalAuditResource;
}

export interface RunGrant {
  kind: "authorized";
  workflow_id: string;
  workflow_permission: WorkflowPermission | null;
}

export type RunAuthorization =
  | ({ kind: "gate" } & Omit<RunAuthorizationRequest, "principal" | "workflow_id">)
  | { kind: "granted"; workflow_permission: WorkflowPermission | null };

interface EnqueueDispatch {
  mode: "enqueue";
  boss: PgBoss;
  trace_id?: string | null;
}

interface ExecuteDispatch {
  mode: "inline" | "background";
  signal?: AbortSignal;
  trace_id?: string | null;
  refusal_answered_to_caller?: boolean;
}

export type RunDispatch = EnqueueDispatch | ExecuteDispatch;

export interface RunWorkflowRequest {
  principal: ResolvedPrincipal;
  workflow_id: string;
  workflow_version_id?: string | undefined;
  expected_workflow_version_id?: string | undefined;
  execution_authority_id?: string | undefined;
  execution_environment: ExecutionMode;
  request_source: RequestSource;
  input?: unknown;
  idempotency_key?: string | null | undefined;
  parent_execution_id?: string | undefined;
  hold_writes?: boolean | undefined;
  authorization: RunAuthorization;
  audit_extra?: Record<string, unknown>;
  replayed_queued?: ReplayedQueuedRun;
  dispatch: RunDispatch;
}

type CompletedWorkflowRun = {
  kind: "completed";
  admitted: AdmittedWorkflowRun;
  result: RunResult;
};

type ReplayedWorkflowRun = { kind: "replayed"; admitted: AdmittedWorkflowRun };

export type InlineRunOutcome = RunRefusal | ReplayedWorkflowRun | CompletedWorkflowRun;

type BackgroundRunOutcome =
  | RunRefusal
  | ReplayedWorkflowRun
  | {
      kind: "started";
      admitted: AdmittedWorkflowRun;
      settled: Promise<CompletedWorkflowRun | RunRefusal>;
    };

type EnqueuedRunOutcome =
  | RunRefusal
  | ReplayedWorkflowRun
  | { kind: "queued"; admitted: AdmittedWorkflowRun }
  | { kind: "enqueue_failed"; admitted: AdmittedWorkflowRun; error: unknown };

type RunWorkflowOutcome = InlineRunOutcome | BackgroundRunOutcome | EnqueuedRunOutcome;

export interface RunWorkflowDeps {
  db: Db;
  gate?: typeof gateWorkflowRunRbac;
  admit?: typeof admitWorkflowRun;
  assertAuthorityCurrent?: (db: Db, tenant_id: string, execution_id: string) => Promise<unknown>;
  auditRefusal?: typeof auditAdmissionRefusal;
  enqueue?: (db: Db, boss: PgBoss, execution_id: string, job: ExecutionRunJob) => Promise<unknown>;
  finalizeFailed?: (
    db: Db,
    tenant_id: string,
    execution_id: string,
    message: string,
  ) => Promise<unknown>;
  run?: typeof runExecution;
}

export function isBearerProductPrincipal(principal: ResolvedPrincipal): boolean {
  return Boolean(principal.product_id) && principal.auth_source?.kind === "external_bearer";
}

export function principalExecutionEnvironment(
  principal: ResolvedPrincipal,
  requested: ExecutionMode | null,
): ExecutionMode {
  const product_id = principal.product_id ?? null;
  const product_environment =
    product_id && isConfigLoaded()
      ? (getConfig().products[product_id]?.execution_environment ?? null)
      : null;
  return resolveExecutionEnvironment({ product_id, product_environment, requested });
}

function enqueueRun(
  db: Db,
  boss: PgBoss,
  execution_id: string,
  job: ExecutionRunJob,
): Promise<unknown> {
  return enqueueExecutionRun(db, boss, { ...job, execution_id });
}

function finalizeEnqueueFailure(
  db: Db,
  tenant_id: string,
  execution_id: string,
  message: string,
): Promise<unknown> {
  return finalizeExecution(
    db,
    tenant_id,
    execution_id,
    { type: "enqueue_failed" },
    { failure: { step_id: null, error_code: "enqueue_failed", error_message: message } },
  );
}

export function createRunWorkflow(deps: RunWorkflowDeps) {
  const db = deps.db;
  const gate = deps.gate ?? gateWorkflowRunRbac;
  const admit = deps.admit ?? admitWorkflowRun;
  const assertAuthorityCurrent = deps.assertAuthorityCurrent ?? assertExecutionAuthorityCurrent;
  const auditRefusal = deps.auditRefusal ?? auditAdmissionRefusal;
  const enqueue = deps.enqueue ?? enqueueRun;
  const finalizeFailed = deps.finalizeFailed ?? finalizeEnqueueFailure;
  const run = deps.run ?? runExecution;

  async function authorize(req: RunAuthorizationRequest): Promise<RunGrant | RunRefusal> {
    const decision = await gate({
      db,
      principal: req.principal,
      workflow_id: req.workflow_id,
      request_source: req.via,
      ...(req.tool ? { tool: req.tool } : {}),
      ...(req.workflow_slug ? { workflow_slug: req.workflow_slug } : {}),
      ...(req.approval ? { approval: req.approval } : {}),
    });
    if (decision.allow)
      return {
        kind: "authorized",
        workflow_id: req.workflow_id,
        workflow_permission: decision.workflow_permission,
      };
    return {
      kind: "rejected",
      code: "permission_denied",
      message: decision.error_message,
      reason: decision.reason,
      refusal: "permission_denied",
    };
  }

  async function authorizeUnresolved(req: {
    principal: ResolvedPrincipal;
    via: WorkflowRunRequestSource;
    tool: string;
    workflow_slug: string;
  }): Promise<RunRefusal | null> {
    const allowlisted = Array.isArray(req.principal.allowed_workflows);
    const decision = allowlisted
      ? { allow: false, reason: undefined }
      : await can(db, {
          tenant_id: req.principal.tenant_id,
          principal: req.principal,
          permission: "workflow:run",
        });
    if (decision.allow) return null;
    const denial = rbacDenial({
      provider: req.principal.provider,
      allowlisted,
      reason: decision.reason,
    });
    await auditAwait(
      {
        tenant_id: req.principal.tenant_id,
        actor_type: req.principal.kind,
        actor_id: req.principal.id,
        action: AuditAction.POLICY_DENIED,
        resource_type: "workflow",
        resource_id: req.workflow_slug,
        result: "denied",
        reason: denial.reason,
        metadata: {
          tool: req.tool,
          via: req.via,
          provider: req.principal.provider,
          permission: "workflow:run",
          workflow_slug: req.workflow_slug,
        },
      },
      db,
    );
    return {
      kind: "rejected",
      code: "permission_denied",
      message: denial.message,
      reason: denial.reason,
      refusal: "permission_denied",
    };
  }

  async function refuse(
    req: RunWorkflowRequest,
    error: unknown,
    stage: RunErrorStage,
    execution_id?: string,
  ): Promise<RunRefusal> {
    const refusal = refusalFromError(error, stage, execution_id);
    if (!refusal) throw error;
    if (refusalIsAudited(refusal.refusal))
      await auditRefusal(
        {
          tenant_id: req.principal.tenant_id,
          reason: refusal.code,
          message: refusal.message,
          workflow_id: req.workflow_id,
          ...(stage === "execution" && execution_id ? { execution_id } : {}),
          request_source: req.request_source,
          actor_id: req.principal.id ?? null,
          actor_type: actorType(req.principal),
          ...(req.audit_extra ? { extra: req.audit_extra } : {}),
        },
        db,
      );
    return refusal;
  }

  async function execute(
    req: RunWorkflowRequest,
    admitted: AdmittedWorkflowRun,
    dispatch: ExecuteDispatch,
  ): Promise<CompletedWorkflowRun | RunRefusal> {
    try {
      const result = await run({
        db,
        tenant_id: req.principal.tenant_id,
        ...(dispatch.refusal_answered_to_caller ? { refusal_answered_to_caller: true } : {}),
        source: {
          kind: "saved",
          workflow_id: req.workflow_id,
          version_id: admitted.workflow_version_id,
        },
        input: admitted.input,
        options: {
          existing_execution_id: admitted.execution_id,
          principal: req.principal,
          execution_mode: req.execution_environment,
          request_source: req.request_source,
          ...(req.parent_execution_id ? { parent_execution_id: req.parent_execution_id } : {}),
          ...(admitted.hold_writes ? { hold_writes: true, self_healing: { enabled: false } } : {}),
          ...(dispatch.signal ? { signal: dispatch.signal } : {}),
          ...(dispatch.trace_id !== undefined ? { trace_id: dispatch.trace_id } : {}),
        },
      });
      return { kind: "completed", admitted, result };
    } catch (error) {
      return refuse(req, error, "execution", admitted.execution_id);
    }
  }

  function runWorkflow(
    req: RunWorkflowRequest & { dispatch: ExecuteDispatch & { mode: "inline" } },
  ): Promise<InlineRunOutcome>;
  function runWorkflow(
    req: RunWorkflowRequest & { dispatch: ExecuteDispatch & { mode: "background" } },
  ): Promise<BackgroundRunOutcome>;
  function runWorkflow(
    req: RunWorkflowRequest & { dispatch: EnqueueDispatch },
  ): Promise<EnqueuedRunOutcome>;
  function runWorkflow(req: RunWorkflowRequest): Promise<RunWorkflowOutcome>;
  async function runWorkflow(req: RunWorkflowRequest): Promise<RunWorkflowOutcome> {
    const idempotency_key = req.idempotency_key ?? null;
    const product_bearer = isBearerProductPrincipal(req.principal);
    const precheck = precheckRunRequest({
      idempotency_key,
      hold_writes: req.hold_writes,
      product_bearer,
      dispatch: req.dispatch.mode,
      execution_authority_id: req.execution_authority_id,
    });
    if (precheck) return precheck;
    let workflow_permission: WorkflowPermission | null;
    if (req.authorization.kind === "granted") {
      workflow_permission = req.authorization.workflow_permission;
    } else {
      const { kind: _kind, ...gateRequest } = req.authorization;
      const authorized = await authorize({
        ...gateRequest,
        principal: req.principal,
        workflow_id: req.workflow_id,
      });
      if (authorized.kind === "rejected") return authorized;
      workflow_permission = authorized.workflow_permission;
    }
    const hold_writes = effectiveHoldWrites(product_bearer, req.hold_writes);
    let admitted: AdmittedWorkflowRun;
    try {
      admitted = await admit(
        {
          tenant_id: req.principal.tenant_id,
          workflow_id: req.workflow_id,
          ...(req.workflow_version_id ? { workflow_version_id: req.workflow_version_id } : {}),
          ...(req.expected_workflow_version_id
            ? { expected_workflow_version_id: req.expected_workflow_version_id }
            : {}),
          ...(req.execution_authority_id
            ? { execution_authority_id: req.execution_authority_id }
            : {}),
          execution_environment: req.execution_environment,
          request_source: req.request_source,
          input: req.input,
          ...(idempotency_key !== null ? { idempotency_key } : {}),
          ...(req.parent_execution_id ? { parent_execution_id: req.parent_execution_id } : {}),
          ...(hold_writes !== undefined ? { hold_writes } : {}),
        },
        db,
        req.principal,
        workflow_permission,
      );
      if (requiresCurrentAuthority(req.dispatch.mode, admitted))
        await assertAuthorityCurrent(db, req.principal.tenant_id, admitted.execution_id);
    } catch (error) {
      return refuse(req, error, "admission");
    }
    if (returnsReplay(admitted, req.replayed_queued ?? "dispatch"))
      return { kind: "replayed", admitted };
    const dispatch = req.dispatch;
    if (dispatch.mode === "enqueue") {
      try {
        await enqueue(db, dispatch.boss, admitted.execution_id, {
          tenant_id: req.principal.tenant_id,
          workflow_id: req.workflow_id,
          execution_id: admitted.execution_id,
          request_source: req.request_source,
          ...(dispatch.trace_id !== undefined ? { trace_id: dispatch.trace_id } : {}),
          execution_mode: req.execution_environment,
        });
      } catch (error) {
        if (finalizesOnEnqueueFailure(idempotency_key))
          await finalizeFailed(
            db,
            req.principal.tenant_id,
            admitted.execution_id,
            enqueueFailureMessage(req.parent_execution_id),
          );
        return { kind: "enqueue_failed", admitted, error };
      }
      return { kind: "queued", admitted };
    }
    if (dispatch.mode === "background")
      return { kind: "started", admitted, settled: execute(req, admitted, dispatch) };
    return execute(req, admitted, dispatch);
  }

  return { authorize, authorizeUnresolved, runWorkflow };
}

export function completedRun(outcome: InlineRunOutcome): CompletedWorkflowRun {
  if (outcome.kind === "completed") return outcome;
  if (outcome.kind === "rejected") throw refusalCause(outcome);
  throw Object.assign(
    new Error(
      `execution ${outcome.admitted.execution_id} already ran under this idempotency key (status: ${outcome.admitted.status})`,
    ),
    { code: "idempotent_replay" },
  );
}

export function runWorkflow(
  request: RunWorkflowRequest,
  deps: RunWorkflowDeps,
): Promise<RunWorkflowOutcome> {
  return createRunWorkflow(deps).runWorkflow(request);
}

export function authorizeWorkflowRun(
  request: RunAuthorizationRequest,
  deps: RunWorkflowDeps,
): Promise<RunGrant | RunRefusal> {
  return createRunWorkflow(deps).authorize(request);
}
