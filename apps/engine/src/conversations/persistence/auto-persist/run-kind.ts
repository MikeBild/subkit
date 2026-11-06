import { completedRun, createRunWorkflow } from "../../../execution/use-cases/run-workflow.ts";
import { logger } from "../../../logging/logger.ts";
import { resolveWorkflowInputContract } from "../../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../../workflows/lookup.ts";
import type { WorkflowDef } from "../../../workflows/types.ts";
import {
  errorDetail,
  inputFileUnavailableResult,
  isRunInputObject,
  mergeRunInput,
  missingInputResult,
  missingRequiredFields,
  readSubmittedWorkflowInput,
  runOutcomeResult,
  staleVersionResult,
} from "../../core/auto-persist.ts";
import type { ToolContext, ToolResult } from "../../tools/index.ts";
import { loadWorkflowInputFile, WorkflowInputFileSchema } from "../../tools/workflow-file-input.ts";
import {
  normalizeWorkflowInput,
  structuredInputFields,
  workflowInputRecord,
} from "../../tools/workflow-input-normalize.ts";
import { invalidIntent, permissionDenied, principalRequired } from "./context.ts";
import { readEnvironment, readString } from "./helpers.ts";
import type { AutoPersistInput, CommitEnv } from "./types.ts";

type FileInput = { ok: true; value: Record<string, unknown> } | { ok: false; result: ToolResult };

async function readFileInput(
  p: AutoPersistInput,
  raw: unknown,
  workflowId: string,
  workflowSlug: string,
): Promise<FileInput> {
  if (raw === undefined) return { ok: true, value: {} };
  try {
    const source = WorkflowInputFileSchema.safeParse(raw);
    if (!source.success) throw new Error("Workflow input file reference is invalid");
    return {
      ok: true,
      value: await loadWorkflowInputFile(
        { db: p.db, tenant_id: p.tenant_id, conversation_id: p.conversation_id },
        source.data,
      ),
    };
  } catch (error) {
    const detail = errorDetail(error);
    logger.warn({
      module: "conversation_persistence",
      action: "auto_persist.run_workflow.input_file_unavailable",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      workflow_id: workflowId,
      detail,
    });
    return { ok: false, result: inputFileUnavailableResult(workflowId, workflowSlug, detail) };
  }
}

async function missingInput(
  p: AutoPersistInput,
  ctx: ToolContext,
  input: unknown,
  workflowId: string,
  workflowSlug: string,
): Promise<ToolResult | null> {
  if (!isRunInputObject(input)) return null;
  const wfForContract = await ctx.engineClient.workflows.get(workflowId);
  const contract = wfForContract?.definition
    ? resolveWorkflowInputContract(wfForContract.definition as WorkflowDef)
    : null;
  if (!contract || contract.required.length === 0) return null;
  const missing = missingRequiredFields(contract.required, workflowInputRecord(input));
  if (missing.length === 0) return null;
  const result = missingInputResult({
    workflowId,
    workflowSlug,
    missing,
    structured: structuredInputFields(contract.schema.properties, missing),
    required: contract.required,
  });
  logger.info({
    module: "conversation_persistence",
    action: "auto_persist.run_workflow.missing_input",
    msg: "run_workflow auto-dispatch blocked before dispatch: required input fields unbound",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    workflow_id: workflowId,
    missing_fields: missing,
  });
  return result;
}

export async function runWorkflowIntent({ p, intent, ctx }: CommitEnv): Promise<ToolResult> {
  const workflowRef =
    readString(intent.payload, "workflow_id") ?? readString(intent.payload, "workflow");
  if (!workflowRef) {
    return invalidIntent(
      "run_workflow commit_intent is missing payload.workflow_id or payload.workflow",
    );
  }
  const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, workflowRef, {
    require_published: true,
  });
  if (!resolved) {
    return {
      ok: false,
      error_code: "workflow_not_found",
      message: `no workflow matched the reference '${workflowRef}'`,
      data: { workflow: workflowRef },
    };
  }
  const workflowId = resolved.id;
  const workflowSlug = readString(intent.payload, "workflow_slug") ?? resolved.slug;
  const expectedWorkflowVersionId = readString(intent.payload, "expected_workflow_version_id");
  const stale = staleVersionResult(
    workflowId,
    expectedWorkflowVersionId,
    resolved.current_version_id,
  );
  if (stale) return stale;
  if (!p.principal) {
    return principalRequired(
      "run_workflow auto-dispatch needs the answering actor's principal for RBAC — re-issue run_workflow in the conversation instead.",
      { workflow_id: workflowId },
    );
  }
  const useCase = createRunWorkflow({ db: p.db });
  const grant = await useCase.authorize({
    principal: p.principal,
    workflow_id: workflowId,
    workflow_slug: workflowSlug,
    via: "auto_persist",
    tool: "run_workflow",
  });
  if (grant.kind === "rejected") return permissionDenied(grant.message, workflowId);
  const normalizedPartial = normalizeWorkflowInput(intent.payload.input_partial);
  const partial = workflowInputRecord(normalizedPartial);
  const answers = readSubmittedWorkflowInput(p.elicitation.tool_name, p.elicitation_output);
  const fileInput = await readFileInput(p, intent.payload.input_file, workflowId, workflowSlug);
  if (!fileInput.ok) return fileInput.result;
  const input = mergeRunInput(normalizedPartial, fileInput.value, partial, answers);
  const missing = await missingInput(p, ctx, input, workflowId, workflowSlug);
  if (missing) return missing;
  const environment = readEnvironment(intent);
  const { admitted, result: run } = completedRun(
    await useCase.runWorkflow({
      principal: p.principal,
      workflow_id: workflowId,
      workflow_version_id: expectedWorkflowVersionId ?? resolved.current_version_id ?? undefined,
      expected_workflow_version_id: expectedWorkflowVersionId,
      execution_environment: environment,
      request_source: "chat",
      input,
      ...(intent.payload.execute_writes === false ? { hold_writes: true } : {}),
      authorization: { kind: "granted", workflow_permission: grant.workflow_permission },
      dispatch: { mode: "inline", trace_id: null },
    }),
  );
  return runOutcomeResult({ run, admitted, workflowId, workflowSlug, input });
}
