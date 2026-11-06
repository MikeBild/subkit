import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { executions, workflowExecutionAuthorities, workflows } from "../db/schema/index.ts";
import { withTenantWork } from "../execution/tenant-work.ts";
import { parsePlaceholders } from "../llm/substitution/parser.ts";
import { resolvePlaceholdersTypePreserving } from "../llm/substitution/resolver.ts";
import { withContext } from "../logging/context.ts";
import { withHostedWork } from "../queue/hosted-work.ts";
import { WorkflowEffectManifestSchema } from "../workflows/effect-manifest.ts";
import { normalizeWorkflowRunInput } from "../workflows/run-input.ts";
import { type CallStep, type WorkflowDef, WorkflowDefSchema } from "../workflows/types.ts";
import { assertCallerExecutionSource } from "./caller-context.ts";
import { resolveExecutionCallerActor } from "./caller-origin.ts";
import { SYSTEM_CLOCK } from "./clock.ts";
import { type RunExecutionSource, resolveDefinition } from "./resolve-definition.ts";
import { checkFinalOutput } from "./run/checks.ts";
import { initialRunState } from "./run/env.ts";
import { finalizeRun } from "./run/finalize.ts";
import { resolveFinalOutput } from "./run/output.ts";
import { planRun } from "./run/plan.ts";
import { prepareRun, type RunExecutionParams } from "./run/prepare.ts";
import { runStepLoop } from "./run/step-loop.ts";
import { isSensitivePayload } from "./sensitive-payload.ts";
import { finalizeExecution } from "./state.ts";
import { MAX_CALL_DEPTH } from "./timeouts.ts";
import type { RunResult, StepResult, StepRunContext } from "./types.ts";

export { rollupConnectorResolutions } from "./engine/connector-rollup.ts";
export type { ScopeEnvelope } from "./engine/envelope.ts";
export { resolveForEachConcurrency } from "./run/for-each.ts";

export async function runExecution(p: RunExecutionParams): Promise<RunResult> {
  return withTenantWork(p.tenant_id, () =>
    withHostedWork(p.db, p.tenant_id, "execution", () => runExecutionAdmitted(p)),
  );
}

async function runExecutionAdmitted(p: RunExecutionParams): Promise<RunResult> {
  assertCallerExecutionSource(p.options?.principal, p.source.kind);
  const [persisted] = p.options?.existing_execution_id
    ? await p.db
        .select({ input: executions.input, workflow_version_id: executions.workflow_version_id })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, p.tenant_id),
            eq(executions.id, p.options.existing_execution_id),
          ),
        )
        .limit(1)
    : [];
  const privacySource =
    persisted?.workflow_version_id && p.source.kind === "saved"
      ? { ...p.source, version_id: persisted.workflow_version_id }
      : p.source;
  const resolved = await resolveDefinition(p.db, p.tenant_id, privacySource);
  const privacy =
    p.options?.execution_privacy ??
    resolved.def.execution_privacy ??
    (isSensitivePayload(persisted?.input) ? "sensitive" : undefined);
  return withContext(
    {
      execution_privacy: privacy,
      tenant_id: p.tenant_id,
      ...(p.options?.existing_execution_id
        ? { execution_id: p.options.existing_execution_id }
        : {}),
    },
    () => runProtectedExecution({ ...p, options: { ...p.options, execution_privacy: privacy } }),
  );
}

async function runProtectedExecution(p: RunExecutionParams): Promise<RunResult> {
  try {
    return await executeRun(p);
  } catch (error) {
    const execution_id = p.options?.existing_execution_id;
    const refusalCode = (error as { code?: unknown }).code;
    const unboundRefusal = [
      "execution_boundary_mismatch",
      "sensitive_resume_forbidden",
      "caller_required",
      "caller_tenant_mismatch",
      "caller_product_mismatch",
      "caller_kind_mismatch",
    ].includes(typeof refusalCode === "string" ? refusalCode : "");
    if (execution_id && !unboundRefusal) {
      const { code, details } = error as { code?: unknown; details?: unknown };
      const named =
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as { step_id?: unknown; connector_id?: unknown; reason?: unknown })
          : {};
      const connectorRefusal = code === "prepared_credential_unavailable";
      const refused = connectorRefusal && p.refusal_answered_to_caller === true;
      await finalizeExecution(
        p.db,
        p.tenant_id,
        execution_id,
        { type: "admission_failed", refused },
        {
          failure: {
            step_id: typeof named.step_id === "string" ? named.step_id : null,
            error_code: typeof code === "string" ? code : "execution_error",
            error_message: error instanceof Error ? error.message : String(error),
            ...(connectorRefusal && typeof named.reason === "string"
              ? {
                  connector: {
                    connector_id:
                      typeof named.connector_id === "string" ? named.connector_id : null,
                    reason: named.reason,
                  },
                }
              : {}),
          },
        },
      ).catch(() => undefined);
    }
    if (p.options?.execution_privacy === "sensitive") {
      const code = (error as { code?: string }).code;
      throw Object.assign(new Error("Sensitive execution could not be resumed or run."), {
        code: [
          "sensitive_resume_forbidden",
          "sensitive_execution_unsupported",
          "execution_boundary_mismatch",
          "input_schema_violation",
        ].includes(code ?? "")
          ? code
          : "sensitive_execution_failure",
      });
    }
    throw error;
  }
}

async function executeRun(p: RunExecutionParams): Promise<RunResult> {
  const prepared = await prepareRun(p, (ctx, step, scope) => runCallStep(p.db, ctx, step, scope));
  if (prepared.kind === "not_started") return prepared.result;
  const { env } = prepared;
  const plan = planRun(env);
  const state = initialRunState(env);
  await runStepLoop(env, plan, state);
  await resolveFinalOutput(env, state);
  const checks = await checkFinalOutput(env, state);
  return finalizeRun(env, state, checks);
}

function collectCredentialTokens(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const tok of parsePlaceholders(v).tokens) {
        if (tok.kind === "cred") found.push(tok.raw);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(value);
  return [...new Set(found)];
}

async function runCallStep(
  db: Db,
  ctx: StepRunContext,
  step: CallStep,
  scope: Record<string, unknown>,
): Promise<StepResult> {
  const clock = ctx.clock ?? SYSTEM_CLOCK;
  const start = clock.now();
  const [parent] = await db
    .select({
      approval: executions.tool_approval_id,
      authority_id: executions.execution_authority_id,
      linked_root: executions.authority_root_execution_id,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenant_id), eq(executions.id, ctx.execution_id)))
    .limit(1);
  if (parent?.approval) {
    await auditAwait(
      {
        tenant_id: ctx.tenant_id,
        ...resolveExecutionCallerActor(ctx.tenant_id, ctx.caller_context, ctx.caller_origin),
        action: AuditAction.APPROVAL_DISPATCH_DENIED,
        resource_type: "execution",
        resource_id: ctx.execution_id,
        result: "denied",
        reason: "prepared_call_unsupported",
        metadata: {
          approval_id: parent.approval,
          step_id: step.id,
          request_source: ctx.request_source,
        },
      },
      db,
    );
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - start,
      error: {
        code: "prepared_call_unsupported",
        message:
          "A prepared parent approval does not authorize a child workflow. Review the child boundary separately.",
      },
    };
  }
  if (ctx.depth + 1 > MAX_CALL_DEPTH) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - start,
      error: {
        code: "call_depth_exceeded",
        message: `max call depth ${MAX_CALL_DEPTH}`,
      },
    };
  }
  let targetId: string | undefined = step.workflow_id;
  if (!targetId && step.workflow_slug) {
    const rows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, step.workflow_slug),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    targetId = rows[0]?.id;
  }
  if (!targetId) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - start,
      error: { code: "call_target_missing", message: "workflow not found" },
    };
  }
  let authorityLink: { root_execution_id: string; call_path: string[] } | null = null;
  let pinnedChildVersion: string | null = null;
  if (parent?.linked_root) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - start,
      error: {
        code: "call_outside_approved_boundary",
        message:
          "A workflow started by an approved run may not start another one. Nothing was started.",
      },
    };
  }
  if (parent?.authority_id) {
    const [authority] = await db
      .select({ manifest: workflowExecutionAuthorities.effect_manifest })
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, ctx.tenant_id),
          eq(workflowExecutionAuthorities.id, parent.authority_id),
        ),
      )
      .limit(1);
    const manifest = WorkflowEffectManifestSchema.safeParse(authority?.manifest);
    const pin = manifest.success
      ? manifest.data.calls?.find((candidate) => candidate.step_id === step.id)
      : undefined;
    if (!pin || pin.workflow_id !== targetId) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - start,
        error: {
          code: "call_outside_approved_boundary",
          message:
            "This run is approved for repeated runs, and the approval does not cover starting this workflow here. Nothing was started. Review and approve this workflow again.",
        },
      };
    }
    const [child] = await db
      .select({ lifecycle: workflows.lifecycle, current: workflows.current_version_id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, targetId),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    if (child?.lifecycle !== "active" || child.current !== pin.workflow_version_id) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - start,
        error: {
          code: "call_child_version_changed",
          message:
            "The workflow this step starts now has a different active version than the one approved. Nothing was started. Review and approve this workflow again.",
        },
      };
    }
    pinnedChildVersion = pin.workflow_version_id;
    authorityLink = { root_execution_id: ctx.execution_id, call_path: [step.id] };
  }
  let resolvedInput: unknown = step.input;
  if (step.input !== undefined && step.input !== null) {
    const credTokens = collectCredentialTokens(step.input);
    if (credTokens.length > 0) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - start,
        error: {
          code: "call_input_credential_forbidden",
          message:
            "call input may not carry credential placeholders (it is persisted with the child execution): " +
            credTokens.join(", ") +
            " — reference the credential inside the called workflow instead",
        },
      };
    }
    const resolverCtx = {
      tenant_id: ctx.tenant_id,
      environment: ctx.execution_mode,
      db: ctx.db,
      input: (scope as Record<string, unknown>).$input,
      scope,
      ...(ctx.principal ? { principal: ctx.principal } : {}),
    };
    const res = await resolvePlaceholdersTypePreserving(step.input, resolverCtx);
    if (res.unresolved.length > 0) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - start,
        error: {
          code: "call_input_unresolved",
          message:
            "call input has unresolved placeholders: " +
            res.unresolved.map((u: { token: string }) => u.token).join(", "),
        },
      };
    }
    resolvedInput = res.value;
  }

  try {
    const childDefinition = await resolveDefinition(db, ctx.tenant_id, {
      kind: "saved",
      workflow_id: targetId,
      ...(pinnedChildVersion ? { version_id: pinnedChildVersion } : {}),
    });
    if (
      ctx.execution_privacy !== "sensitive" &&
      childDefinition.def.execution_privacy === "sensitive"
    ) {
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: clock.now() - start,
        error: {
          code: "sensitive_execution_unsupported",
          message: "A sensitive child workflow requires a sensitive parent execution.",
        },
      };
    }
    const child = await runExecution({
      db,
      clock,
      ...(ctx.ids ? { ids: ctx.ids } : {}),
      tenant_id: ctx.tenant_id,
      source: {
        kind: "saved",
        workflow_id: targetId,
        ...(childDefinition.workflow_version_id
          ? { version_id: childDefinition.workflow_version_id }
          : {}),
      },
      input: normalizeWorkflowRunInput(resolvedInput, childDefinition.def.input_schema) ?? null,
      options: {
        request_source: "tool-chain",
        parent_execution_id: ctx.execution_id,
        ...(authorityLink ? { authority_link: authorityLink } : {}),
        depth: ctx.depth + 1,
        signal: ctx.signal,
        trace_id: ctx.trace_id ?? null,
        execution_mode: ctx.execution_mode,
        ...(ctx.hold_writes ? { hold_writes: true } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        caller_context: ctx.caller_context ?? null,
        caller_origin: ctx.caller_origin ?? "unknown",
        execution_privacy: ctx.execution_privacy,
      },
    });
    return {
      status: child.status === "succeeded" ? "succeeded" : "failed",
      ...(child.warnings?.length ? { warnings: child.warnings } : {}),
      output: {
        execution_id: child.execution_id,
        status: child.status,
        output: child.output,
      },
      retry_count: 0,
      duration_ms: clock.now() - start,
      error:
        child.status === "succeeded"
          ? null
          : (child.error ?? {
              code: "child_failed",
              message: `child status ${child.status}`,
            }),
    };
  } catch (err) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: clock.now() - start,
      error: {
        code: "call_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export type { RunExecutionSource, WorkflowDef };
export { WorkflowDefSchema };
