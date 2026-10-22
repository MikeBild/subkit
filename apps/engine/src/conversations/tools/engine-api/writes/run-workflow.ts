import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { conversations, workflowVersions } from "../../../../db/schema/index.ts";
import { runExecution } from "../../../../execution/engine.ts";
import { admitWorkflowRun } from "../../../../execution/workflow-run-admission.ts";
import { logger } from "../../../../logging/logger.ts";
import { recordAuthoringGateBlock } from "../../../../observability/instrumentation.ts";
import { workflowExecutionEnvironment } from "../../../../workflows/execution-environment.ts";
import { resolveWorkflowInputContract } from "../../../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../../../workflows/lookup.ts";
import { workflowPreparationInput } from "../../../../workflows/preparation-input.ts";
import { gateWorkflowRunRbac } from "../../../../workflows/rbac.ts";
import { buildScopeAtStep } from "../../../../workflows/scope-shape.ts";
import type { WorkflowDef } from "../../../../workflows/types.ts";
import {
  bindPersistedWorkflow,
  getWorkflowDraft,
  WORKFLOW_BINDING_TOOL,
  withLatestPreview,
  withWorkflowExecution,
} from "../../../authoring-state.ts";
import { hydrateBoundWorkflow } from "../../../draft.ts";
import { stampStepTraceFingerprints } from "../../../step-fingerprint.ts";
import type { DraftDocument } from "../../../types.ts";
import { pauseForUserInput } from "../../ask-user/common.ts";
import { buildGateError, buildLifecyclePayload } from "../../authoring-contract.ts";
import type { ConversationTool } from "../../index.ts";
import { buildRawStepResults } from "../../step-results.ts";
import { sampleWorkflowOutputForLlm, truncateStepPreviewForLlm } from "../../truncate.ts";
import { workflowInputSlot } from "../../workflow-input-normalize.ts";
import { activationRequiredRefusal } from "./activation-required.ts";
import { detectRepairLoop } from "./repair-loop-history.ts";
import { describeRunWorkflowError } from "./run-workflow-error.ts";

const Input = z
  .object({
    workflow: z.string().min(1).max(256).optional(),
    input: workflowInputSlot.optional(),
    environment: z
      .enum(["dev", "prod"])
      .optional()
      .describe(
        "Use the workflow schedule environment when omitted; specify only for an explicit environment change.",
      ),
    expected_workflow_version_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Run only this exact active version. Use for a test that was prepared against a reviewed version.",
      ),
    idempotency_key: z.string().min(1).max(200).optional(),
    include_step_trace: z.boolean().optional(),
    include_step_results: z.boolean().optional(),
    execute_writes: z.boolean().optional(),
  })
  .openapi("RunWorkflowToolInput");

type RunWorkflowArgs = z.infer<typeof Input>;

type RunWorkflowStatus = "succeeded" | "failed" | "partial_success" | "running";

function withStatus(
  data: Record<string, unknown>,
  status: RunWorkflowStatus,
): Record<string, unknown> {
  if (typeof data.status === "string") return data;
  return { ...data, status };
}

export const runWorkflowTool: ConversationTool = {
  name: "run_workflow",
  description:
    "Start a new run of an ALREADY-SAVED workflow. Use only when the user requests a new run or preview; execute_writes: false still starts a DEV run and is not a historical read. For inspection of an existing run, use execution history, get_execution, inspect_execution_step or diagnose_latest_execution instead. Never call this tool when the user says not to run, execute, test-run or start a workflow. Use `wf_<slug>` only when the user asks to perform the actual workflow now; it may request a one-shot live execution decision. Accepts `workflow` as a slug or UUID. Every start requires matching local execution authority; otherwise writes are HELD and the envelope reports writes_held + held_step_ids. Setting execute_writes: true does not grant authority or bypass limits. To verify a DRAFT, use `dry_run_workflow`, never `run_workflow`; this starts a preview run and is prohibited by an explicit no-run instruction. A saved inactive draft is previewed with `dry_run_workflow` (held writes, activates nothing); `run_workflow` starts runs of the active version only. Never call this tool when the user says not to activate anything or not to cause live effects. Do NOT use `run_workflow` to build/create/test a NEW workflow (even if the user pasted example data or JSONata) — that is authoring intent: call `author_workflow` (then `edit_workflow_patch` for edits).",
  inputSchema: Input,
  category: "tenant_write",
  visible_when_readonly: true,
  requires_persisted_workflow: true,
  async execute(ctx, args: RunWorkflowArgs) {
    const currentDraft = ctx.getDraft();
    const activeTarget = currentDraft.summary?.active_target ?? null;
    let workflowId: string | null = null;
    if (args.workflow) {
      const resolved = await resolveWorkflowByIdOrSlug(ctx.db, ctx.tenant_id, args.workflow);
      if (!resolved) {
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "workflow_not_found",
              message: `no workflow matched the reference '${args.workflow}' — pass a slug or UUID from the TENANT SNAPSHOT block`,
              next_best_actions: ["list_workflows", "find_workflow"],
            },
            "failed",
          ),
        };
      }
      workflowId = resolved.id;
    } else if (activeTarget?.kind === "workflow" && activeTarget.lifecycle_state === "persisted") {
      workflowId = activeTarget.id;
    }
    if (!workflowId) {
      const draftSteps = getWorkflowDraft(currentDraft).steps;
      const hasDraftSteps = Array.isArray(draftSteps) && draftSteps.length > 0;
      const message = hasDraftSteps
        ? "commit the workflow before running it from the conversation surface"
        : "there is no workflow to run yet — author one first. If the user asked to BUILD or CREATE a workflow, call author_workflow (the one-shot grounded builder). run_workflow only executes a workflow that has already been authored and saved.";
      const next_best_actions = hasDraftSteps
        ? ["dry_run_workflow", "save_workflow_draft"]
        : ["author_workflow"];
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message,
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
            next_best_actions,
          }),
          "failed",
        ),
      };
    }
    const wf = await ctx.engineClient.workflows.get(workflowId);
    if (!wf) return { ok: false, data: withStatus({ error: "workflow_not_found" }, "failed") };
    const requestSource = ctx.direct_mcp_invocation === true ? "mcp" : "chat";
    const sensitive = (wf.definition as WorkflowDef).execution_privacy === "sensitive";
    if (
      args.expected_workflow_version_id &&
      args.expected_workflow_version_id !== wf.current_version_id
    ) {
      return {
        ok: false,
        data: withStatus(
          {
            error_code: "workflow_version_not_active",
            message:
              "the prepared workflow version is no longer the active version; review the current version before running it",
            workflow_id: workflowId,
            expected_workflow_version_id: args.expected_workflow_version_id,
            current_workflow_version_id: wf.current_version_id ?? null,
          },
          "failed",
        ),
      };
    }
    const environment =
      args.environment ?? (await workflowExecutionEnvironment(ctx.db, ctx.tenant_id, workflowId));
    const bound = currentDraft.state?.persisted_resources.find(
      (resource) => resource.kind === "workflow" && resource.id === workflowId,
    );
    if (
      !wf.current_version_id ||
      (bound?.persistence_kind === "draft" && bound.version_id !== wf.current_version_id)
    ) {
      return {
        ok: false,
        data: withStatus(
          await activationRequiredRefusal(ctx, {
            workflow_id: workflowId,
            draft_version_id: bound?.version_id ?? wf.draft_version_id ?? null,
            current_version_id: wf.current_version_id ?? null,
          }),
          "failed",
        ),
      };
    }
    const inputContract = resolveWorkflowInputContract(wf.definition as WorkflowDef);
    const suppliedInput = await workflowPreparationInput(
      ctx.db,
      ctx.tenant_id,
      workflowId,
      environment,
      args,
    );
    const suppliedInputIsEmpty =
      suppliedInput === undefined || Object.keys(suppliedInput).length === 0;
    if (inputContract) {
      const properties =
        inputContract.schema.properties && typeof inputContract.schema.properties === "object"
          ? (inputContract.schema.properties as Record<string, unknown>)
          : {};
      const propertyNames = inputContract.properties;
      const requiredKeys = inputContract.required;
      const suppliedMap = suppliedInput ?? {};
      const missingRequired = requiredKeys.filter((k) => {
        const v = suppliedMap[k];
        return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      });
      if (missingRequired.length > 0 && propertyNames.length > 0) {
        const requiredSet = new Set(requiredKeys);
        const fields = propertyNames.map((name) => {
          const prop =
            properties[name] && typeof properties[name] === "object"
              ? (properties[name] as Record<string, unknown>)
              : {};
          const type =
            prop.type === "number" || prop.type === "integer"
              ? ("number" as const)
              : prop.type === "boolean"
                ? ("boolean" as const)
                : ("text" as const);
          const supplied = suppliedMap[name];
          const fallbackDefault = prop.default;
          const defaultValue =
            typeof supplied === "string" ||
            typeof supplied === "number" ||
            typeof supplied === "boolean"
              ? supplied
              : typeof fallbackDefault === "string" ||
                  typeof fallbackDefault === "number" ||
                  typeof fallbackDefault === "boolean"
                ? fallbackDefault
                : undefined;
          return {
            name,
            label: name,
            type,
            required: requiredSet.has(name),
            ...(typeof prop.description === "string" ? { placeholder: prop.description } : {}),
            ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          };
        });
        logger.info({
          module: "conversation_tool",
          action: "run_workflow.input_form_elicited",
          msg: "run_workflow paused with an auto-generated input form",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          workflow_slug: wf.slug,
          missing_required: missingRequired,
        });
        return pauseForUserInput(ctx, {
          tool_name: "ask_user_form",
          summary: `Workflow "${wf.slug}" needs input before it can run`,
          input: {
            question: `Workflow "${wf.slug}" needs the following input${fields.length === 1 ? "" : "s"} to run:`,
            fields,
            commit_intent: {
              kind: "run_workflow",
              payload: {
                workflow_id: workflowId,
                workflow_slug: wf.slug,
                environment,
                input_partial: suppliedMap,
                ...(args.expected_workflow_version_id
                  ? { expected_workflow_version_id: args.expected_workflow_version_id }
                  : {}),
                ...(args.execute_writes === false ? { execute_writes: false } : {}),
              },
              description: `Run workflow "${wf.slug}" with the submitted input`,
            },
          },
        });
      }
    }
    const inputIgnored = inputContract === null && !suppliedInputIsEmpty;
    if (
      activeTarget?.kind === "workflow" &&
      activeTarget.lifecycle_state === "draft_only" &&
      !args.workflow
    ) {
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "workflow_not_persisted",
            message: "commit the current workflow draft before running it",
            recommended_mode: "workflow",
            stale_checkpoints: ["workflow_persisted"],
          }),
          "failed",
        ),
      };
    }

    const breaker = await detectRepairLoop(ctx.db, ctx.tenant_id, ctx.conversation_id);
    if (breaker.tripped) {
      logger.warn({
        module: "conversation_tool",
        action: "run_workflow.repair_loop_detected",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        recent_codes: breaker.recent_codes,
        tripped_codes: breaker.tripped_codes,
      });
      recordAuthoringGateBlock({ code: "repair_loop_detected", tool: "run_workflow" });
      const codesPretty = breaker.tripped_codes.map((c) => `\`${c.code}\` × ${c.count}`).join(", ");
      const execFailureTrip = breaker.tripped_codes.some((c) => c.code.startsWith("exec_failed:"));
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: "repair_loop_detected",
            message: execFailureTrip
              ? `stop — this workflow has failed at runtime three or more times with the same error: ${codesPretty}. Re-running the same draft will fail the same way. Run \`diagnose_latest_execution\` to read the failing step, then fix the actual cause or ask the user what they want — do NOT re-run this draft unchanged. A common cause: a request step calls an endpoint that rejects the value you pass (many APIs have no "by-name" lookup and need a search/resolve step that turns the name into an id first).`
              : `stop — three or more consecutive runs of this workflow surfaced the same authoring-bug warning(s): ${codesPretty}. The current strategy is not working. Read \`data-handling.md\` and \`workflow-authoring.md\` for the loop+JSONata scope rules, ask the user what output they actually want, and propose a structurally different draft. Re-running this one will produce the same warning.`,
            recommended_mode: "diagnosis",
            next_best_actions: [
              "ask_user_text",
              "diagnose_latest_execution",
              "inspect_workflow_draft",
              "load_skill",
              "search_knowledge",
            ],
            extra: {
              recent_warning_codes: breaker.recent_codes,
              tripped_codes: breaker.tripped_codes,
            },
          }),
          "failed",
        ),
      };
    }

    try {
      if (!ctx.principal) {
        logger.warn({
          module: "conversation_tool",
          action: "run_workflow.no_principal",
          msg: "run_workflow invoked without ctx.principal — refusing rather than bypassing RBAC",
          tenant_id: ctx.tenant_id,
          workflow_id: workflowId,
        });
        recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "principal_required",
              message:
                "run_workflow requires an authenticated principal on the ToolContext; production callers must thread it from the auth resolution.",
              workflow_slug: wf.slug,
            },
            "failed",
          ),
        };
      }
      const rbac = await gateWorkflowRunRbac({
        db: ctx.db,
        principal: ctx.principal,
        workflow_id: workflowId,
        workflow_slug: wf.slug,
        request_source: requestSource,
        tool: "run_workflow",
      });
      if (!rbac.allow) {
        return {
          ok: false,
          data: withStatus(
            {
              error_code: "permission_denied",
              permission: "workflow:run",
              reason: rbac.reason,
              message: rbac.error_message,
              workflow_slug: wf.slug,
            },
            "failed",
          ),
        };
      }
      ctx.onLog?.(
        "info",
        `running workflow ${wf.slug} (v${wf.current_version}) in env=${environment}`,
      );
      const admitted = await admitWorkflowRun(
        {
          tenant_id: ctx.tenant_id,
          workflow_id: workflowId,
          workflow_version_id: args.expected_workflow_version_id ?? wf.current_version_id,
          ...(args.expected_workflow_version_id
            ? { expected_workflow_version_id: args.expected_workflow_version_id }
            : {}),
          execution_environment: environment,
          request_source: requestSource,
          input: suppliedInput,
          ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
          ...(args.execute_writes === false ? { hold_writes: true } : {}),
        },
        ctx.db,
        ctx.principal,
        rbac.workflow_permission,
      );
      const holdWrites = admitted.hold_writes;
      if (args.idempotency_key) {
        const existing = admitted.replayed
          ? { id: admitted.execution_id, status: admitted.status }
          : null;
        if (existing) {
          const replayRunning = ["queued", "running"].includes(existing.status);
          return {
            ok: true,
            data: withStatus(
              {
                execution_id: existing.id,
                execution_status: existing.status,
                ...(admitted
                  ? {
                      workflow_version_id: admitted.workflow_version_id,
                      execution_authority_id: admitted.execution_authority_id,
                      hold_writes: admitted.hold_writes,
                    }
                  : {}),
                idempotent_replay: true,
                message: replayRunning
                  ? `nothing new was started — execution ${existing.id} is still running under idempotency key '${args.idempotency_key}' (status: ${existing.status}); inspect it with get_execution`
                  : `nothing new was started — execution ${existing.id} already ran under idempotency key '${args.idempotency_key}' (status: ${existing.status}); inspect it with get_execution`,
              },
              existing.status === "succeeded" ? "succeeded" : replayRunning ? "running" : "failed",
            ),
          };
        }
      }
      const result = await runExecution({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        source: {
          kind: "saved",
          workflow_id: workflowId,
          version_id: admitted?.workflow_version_id ?? wf.current_version_id,
        },
        input: admitted ? admitted.input : suppliedInput,
        options: {
          request_source: requestSource,
          trace_id: null,
          principal: ctx.principal,
          execution_mode: environment,
          ...(admitted ? { existing_execution_id: admitted.execution_id } : {}),
          ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}),
          ...(holdWrites ? { hold_writes: true } : {}),
        },
      });
      const heldStepIds = holdWrites
        ? result.steps
            .filter(
              (s) =>
                (s as { held?: boolean }).held === true ||
                (s.error &&
                  typeof s.error === "object" &&
                  (s.error as { code?: unknown }).code === "skipped_dependency_held"),
            )
            .map((s) => s.step_key)
        : [];
      for (const step of result.steps) {
        const errMsg =
          step.error && typeof step.error === "object" && step.error !== null
            ? (step.error as { message?: unknown }).message
            : null;
        const level: "info" | "warn" | "error" =
          step.status === "succeeded"
            ? "info"
            : step.status === "failed" || step.status === "timed_out"
              ? "error"
              : "warn";
        ctx.onLog?.(
          level,
          `step ${step.step_key} (${step.kind}) ${step.status}${
            step.duration_ms != null ? ` · ${step.duration_ms}ms` : ""
          }${typeof errMsg === "string" ? ` · ${errMsg}` : ""}`,
        );
      }
      for (const w of result.warnings ?? []) {
        ctx.onLog?.(
          "warn",
          `step ${w.step_key} · ${w.code}${w.identifier ? ` · ${w.identifier}` : ""} · ${w.message}`,
        );
      }
      await ctx.engineClient.audit_write({
        resource_type: "execution",
        resource_id: result.execution_id,
        action: "conversation.run_workflow",
        result: result.status === "succeeded" ? "success" : "error",
        metadata: {
          conversation_id: ctx.conversation_id,
          workflow_id: workflowId,
          environment,
          final_status: result.status,
          execute_writes: !holdWrites,
          execution_authority_id: admitted?.execution_authority_id ?? null,
          ...(heldStepIds.length > 0 ? { held_step_ids: heldStepIds } : {}),
        },
      });
      const hasWarnings = (result.warnings?.length ?? 0) > 0;
      const hasUnresolvedIdentifierWarning = (result.warnings ?? []).some(
        (w) => w.code === "unresolved_identifier",
      );
      const hasTransformEmptyExtractionWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_empty_extraction",
      );
      const _hasTransformDroppedFieldsWarning = (result.warnings ?? []).some(
        (w) => w.code === "transform_dropped_fields",
      );
      const hasLoopOverUnresolvedWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_over_unresolved",
      );
      const hasLoopBodyEmptyWarning = (result.warnings ?? []).some(
        (w) => w.code === "loop_body_empty",
      );
      const loopStepRanWithEmptyBody =
        hasLoopBodyEmptyWarning ||
        (result.steps.some((s) => s.kind === "loop" && s.status === "succeeded") &&
          Array.isArray(result.output) &&
          (result.output as unknown[]).length === 0);
      const isPartialSuccess =
        result.status === "succeeded" &&
        (hasUnresolvedIdentifierWarning ||
          loopStepRanWithEmptyBody ||
          hasTransformEmptyExtractionWarning ||
          hasLoopOverUnresolvedWarning);
      const payloadStatus = isPartialSuccess ? "partial_success" : result.status;
      const requiresRepair =
        hasUnresolvedIdentifierWarning ||
        hasTransformEmptyExtractionWarning ||
        hasLoopOverUnresolvedWarning ||
        isPartialSuccess;
      const diagnosisAvailable = hasWarnings || result.status !== "succeeded" || isPartialSuccess;
      const stepTraceEntries = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : null;
        const previewForLlm =
          s.output_preview !== undefined && s.output_preview !== null
            ? truncateStepPreviewForLlm(s.output_preview)
            : null;
        const rawForLlm =
          s.raw_preview !== undefined && s.raw_preview !== null
            ? truncateStepPreviewForLlm(s.raw_preview)
            : null;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.request_meta !== undefined && s.request_meta !== null
            ? { request_meta: s.request_meta }
            : {}),
          ...(previewForLlm
            ? {
                output_preview: previewForLlm.data,
                ...(previewForLlm.raw_ref ? { output_preview_ref: previewForLlm.raw_ref } : {}),
              }
            : {}),
          ...(rawForLlm
            ? {
                raw_preview: rawForLlm.data,
                ...(rawForLlm.raw_ref ? { raw_preview_ref: rawForLlm.raw_ref } : {}),
              }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
          ...(s.error ? { error: s.error } : {}),
        };
      });
      const includeStepTrace =
        args.include_step_trace === true ||
        result.status !== "succeeded" ||
        isPartialSuccess ||
        hasWarnings;
      const persistedStepTracesUnstamped = result.steps.map((s) => {
        const errorCode =
          s.error && typeof s.error === "object" && s.error !== null
            ? (s.error as { code?: unknown }).code
            : undefined;
        const scope =
          s.output_preview !== undefined && s.output_preview !== null
            ? buildScopeAtStep(s.output_preview)
            : undefined;
        return {
          step_id: s.step_key,
          kind: s.kind,
          status: s.status,
          ...(s.duration_ms != null ? { duration_ms: s.duration_ms } : {}),
          ...(s.output_preview !== undefined && s.output_preview !== null
            ? { output_preview: s.output_preview }
            : {}),
          ...(s.raw_preview !== undefined && s.raw_preview !== null
            ? { raw_preview: s.raw_preview }
            : {}),
          ...(scope ? { scope_at_step: scope } : {}),
          ...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
        };
      });
      const persistedStepTraces = stampStepTraceFingerprints(
        persistedStepTracesUnstamped,
        (((wf.definition as WorkflowDef | null)?.steps ?? []) as unknown[]).filter(
          (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
        ),
      );
      const runPreview = {
        ok: payloadStatus === "succeeded",
        step_id:
          result.steps.find((s) => s.status !== "succeeded")?.step_key ??
          result.steps[result.steps.length - 1]?.step_key ??
          "(end)",
        summary: `run_workflow finished with status ${payloadStatus}`,
        ...(hasWarnings && result.warnings ? { warnings: result.warnings } : {}),
        ...(requiresRepair ? { requires_repair: true } : {}),
        step_traces: persistedStepTraces,
        input: suppliedInput ?? null,
      };
      const previewed = (draft: DraftDocument) =>
        withLatestPreview(draft, runPreview, "run_workflow", "workflow_executed");
      if (result.status === "succeeded" && !isPartialSuccess && wf.current_version_id) {
        const persistedScopeIndex: Record<
          string,
          { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
        > = {};
        for (const trace of persistedStepTraces) {
          if (trace.scope_at_step) {
            persistedScopeIndex[trace.step_id] = {
              available_paths: trace.scope_at_step.available_paths,
              shape_summary: trace.scope_at_step.shape_summary,
              primary_data_path: trace.scope_at_step.primary_data_path ?? null,
            };
          }
        }
        if (Object.keys(persistedScopeIndex).length > 0) {
          try {
            await ctx.db
              .update(workflowVersions)
              .set({ scope_index: persistedScopeIndex })
              .where(
                and(
                  eq(workflowVersions.tenant_id, ctx.tenant_id),
                  eq(workflowVersions.id, wf.current_version_id),
                ),
              );
          } catch (err) {
            logger.warn({
              module: "conversation_tool",
              action: "run_workflow.scope_index_persist_failed",
              tenant_id: ctx.tenant_id,
              workflow_id: workflowId,
              workflow_version_id: wf.current_version_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      const runsAuthoringTarget =
        activeTarget?.kind === "workflow" && activeTarget.id === workflowId;
      const authorsNothing =
        getWorkflowDraft(currentDraft).steps.length === 0 &&
        !currentDraft.state?.persisted_resources.some((resource) => resource.kind === "workflow");
      if (!runsAuthoringTarget && authorsNothing)
        await ctx.db
          .update(conversations)
          .set({ target_workflow_id: workflowId, updated_at: new Date() })
          .where(
            and(
              eq(conversations.tenant_id, ctx.tenant_id),
              eq(conversations.id, ctx.conversation_id),
            ),
          );
      const boundDraft = runsAuthoringTarget
        ? bindPersistedWorkflow(
            previewed(currentDraft),
            {
              kind: "workflow",
              id: workflowId,
              slug: wf.slug,
              name: wf.name,
              version_id: wf.current_version_id,
              version: wf.current_version,
              environment: null,
              saved_at: wf.updated_at.toISOString(),
            },
            {
              tool_name:
                currentDraft.state?.checkpoints.workflow_persisted?.verified_by_tool ??
                WORKFLOW_BINDING_TOOL,
            },
          )
        : authorsNothing
          ? previewed(await hydrateBoundWorkflow(ctx.tenant_id, workflowId, currentDraft, ctx.db))
          : currentDraft;
      const nextDraft = withWorkflowExecution(boundDraft, {
        execution_id: result.execution_id,
        workflow_id: workflowId,
        workflow_version_id: wf.current_version_id,
        status: payloadStatus,
        environment,
        warnings_count: result.warnings?.length ?? 0,
        recorded_at: new Date().toISOString(),
        diagnosis_available: diagnosisAvailable,
        ...(requiresRepair ? { requires_repair: true } : {}),
      });
      await ctx.setDraft(nextDraft);
      const firstFailedStep =
        payloadStatus === "failed"
          ? result.steps.find((s) => s.status === "failed" || s.status === "timed_out")
          : undefined;
      const failureStepKey = firstFailedStep?.step_key;
      const failureReason =
        firstFailedStep?.error &&
        typeof firstFailedStep.error === "object" &&
        firstFailedStep.error !== null
          ? typeof (firstFailedStep.error as { message?: unknown }).message === "string"
            ? ((firstFailedStep.error as { message: string }).message ?? null)
            : null
          : null;
      const sampledOutput = sampleWorkflowOutputForLlm(result.output);
      return {
        ok: result.status === "succeeded" && !isPartialSuccess,
        data: withStatus(
          buildLifecyclePayload(nextDraft, {
            execution_id: result.execution_id,
            workflow_id: workflowId,
            workflow_version_id: wf.current_version_id,
            workflow_version: wf.current_version,
            execution_authority_id: admitted?.execution_authority_id ?? null,
            hold_writes: holdWrites,
            ...(heldStepIds.length > 0
              ? {
                  writes_held: true,
                  held_step_ids: heldStepIds,
                  writes_held_note: `${heldStepIds.length} write step(s) were resolved but NOT dispatched. No held write was sent. Use the prepared wf_${wf.slug} tool for an exact one-shot human decision, or obtain a bounded execution authority for this version. Setting execute_writes:true cannot release held writes or bypass an expired, revoked or exhausted authority. Never approve on the user's behalf.`,
                }
              : {}),
            ...(failureStepKey ? { failure_step_key: failureStepKey } : {}),
            ...(failureReason ? { failure_reason: failureReason } : {}),
            ...(inputIgnored
              ? {
                  input_ignored: true,
                  input_ignored_note: `workflow "${wf.slug}" does not declare an input_schema; the supplied input was discarded. Tell the user the workflow accepts no inputs (or edit the workflow to bind one).`,
                }
              : {}),
            status: payloadStatus,
            output: sampledOutput.value,
            ...(sampledOutput.sampled
              ? {
                  output_sampled: true,
                  output_note: `output is a sample (in-band "… sampled N of M" markers mark the cut points); retrieve larger payloads via get_raw_result(ref="${sampledOutput.raw_ref}") and follow its bounded field retrieval instructions, or use inspect_execution_step. Present the sampled rows to the user directly — do NOT re-run the workflow to "get" the output.`,
                  ...(sampledOutput.raw_ref ? { output_raw_ref: sampledOutput.raw_ref } : {}),
                }
              : {}),
            ...(result.error ? { error: result.error } : {}),
            diagnosis_available: diagnosisAvailable,
            requires_repair: requiresRepair,
            recommended_next_tool: diagnosisAvailable ? "diagnose_latest_execution" : null,
            ...(diagnosisAvailable && result.warnings && result.warnings.length > 0
              ? {
                  warning_summary: `${result.warnings.length} warning(s): ${Array.from(
                    new Set(result.warnings.map((w) => w.code)),
                  )
                    .sort()
                    .join(", ")}. Run \`diagnose_latest_execution\` for details.`,
                }
              : {}),
            next_best_actions: diagnosisAvailable
              ? ["diagnose_latest_execution"]
              : result.status === "succeeded"
                ? ["inspect_execution_step", "run_workflow"]
                : ["diagnose_latest_execution", "inspect_workflow"],
            next_prompt: diagnosisAvailable
              ? "Open diagnosis to see what happened"
              : result.status === "succeeded"
                ? "Inspect step output or run again"
                : "Diagnose the failure",
            ...(hasWarnings && result.warnings
              ? {
                  warnings_banner: {
                    count: result.warnings.length,
                    codes: Array.from(new Set(result.warnings.map((w) => w.code))).sort(),
                    summary: `${result.warnings.length} warning(s): ${Array.from(
                      new Set(result.warnings.map((w) => w.code)),
                    )
                      .sort()
                      .join(", ")}`,
                    entries: result.warnings,
                  },
                }
              : {}),
            ...(hasWarnings ? { warnings: result.warnings } : {}),
            ...(includeStepTrace ? { step_trace: stepTraceEntries } : {}),
            ...(args.include_step_results && !sensitive
              ? { step_results: buildRawStepResults(result.steps) }
              : {}),
            suggested_command: `/workflows run ${wf.slug}`,
          }),
          "failed",
        ),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.engineClient.audit_write({
        resource_type: "workflow",
        resource_id: workflowId,
        action: "conversation.run_workflow",
        result: "error",
        reason: msg,
        metadata: { conversation_id: ctx.conversation_id },
      });
      const failure = describeRunWorkflowError(err);
      return {
        ok: false,
        data: withStatus(
          buildGateError(currentDraft, {
            error_code: failure.error_code,
            message: failure.message,
            recommended_mode: failure.recommended_mode,
            ...(failure.recoverable
              ? {}
              : { next_best_actions: [], extra: { recoverable: false } }),
          }),
          "failed",
        ),
      };
    }
  },
};
