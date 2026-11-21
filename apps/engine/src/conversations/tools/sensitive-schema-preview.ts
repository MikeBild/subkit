import { logger } from "../../logging/index.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { withLatestPreview } from "../authoring-state/index.ts";
import { runRecordedEval } from "../recorded-eval.ts";
import { buildLifecyclePayload } from "./authoring-contract.ts";
import type { ToolContext, ToolResult } from "./index.ts";
import { clearLastPreview } from "./last-preview-store.ts";
import { SCHEMA_ONLY_NOTE, SENSITIVE_LIVE_VERIFICATION_HANDOFF } from "./sensitive-envelope.ts";

export interface SchemaOnlyExpressionFinding {
  site: string;
  step_id: string | null;
  status: "compile_error" | "not_evaluated" | "ok";
  message?: string;
}

export interface SchemaOnlyPreviewSummary {
  mode: "schema_only";
  status: "passed" | "failed";
  structure_checked: true;
  content_checked: false;
  content_withheld: true;
  requests: "held";
  steps: Array<{ id: string; kind: string }>;
  expressions: SchemaOnlyExpressionFinding[];
  counts: { steps: number; expressions: number; compile_errors: number };
  verification_stage: "schema_only";
  note: string;
}

function projectFindingStatus(status: string): SchemaOnlyExpressionFinding["status"] {
  if (status === "compile_error") return "compile_error";
  if (status === "ok") return "ok";
  return "not_evaluated";
}

export async function schemaOnlyPreviewSummary(
  definition: WorkflowDef,
): Promise<SchemaOnlyPreviewSummary> {
  const steps = definition.steps as unknown as ReadonlyArray<Record<string, unknown>>;
  const report = await runRecordedEval(
    {
      steps,
      ...(typeof definition.output_transform === "string"
        ? { output_transform: definition.output_transform }
        : {}),
    },
    { latest_preview: null, scope: null, input: null },
  );
  const expressions = report.expressions.map((finding) => {
    const status = projectFindingStatus(finding.status);
    return {
      site: finding.site,
      step_id: finding.step_id,
      status,
      ...(status === "compile_error" && finding.message ? { message: finding.message } : {}),
    };
  });
  const compileErrors = expressions.filter((finding) => finding.status === "compile_error").length;
  return {
    mode: "schema_only",
    status: compileErrors === 0 ? "passed" : "failed",
    structure_checked: true,
    content_checked: false,
    content_withheld: true,
    requests: "held",
    steps: steps.map((step) => ({
      id: typeof step.id === "string" ? step.id : "(unknown)",
      kind: typeof step.kind === "string" ? step.kind : "unknown",
    })),
    expressions,
    counts: { steps: steps.length, expressions: expressions.length, compile_errors: compileErrors },
    verification_stage: "schema_only",
    note: SCHEMA_ONLY_NOTE,
  };
}

export async function runSensitiveSchemaPreview(p: {
  ctx: ToolContext;
  definition: WorkflowDef;
}): Promise<ToolResult> {
  const { ctx } = p;
  clearLastPreview({ tenant_id: ctx.tenant_id, conversation_id: ctx.conversation_id });
  const summary = await schemaOnlyPreviewSummary(p.definition);
  const green = summary.status === "passed";
  const line = green
    ? `${SCHEMA_ONLY_NOTE} The definition validates and its ${summary.counts.expressions} expression(s) compile; no request was dispatched and no data was read. ${SENSITIVE_LIVE_VERIFICATION_HANDOFF}`
    : `${SCHEMA_ONLY_NOTE} ${summary.counts.compile_errors} expression(s) do not compile; no request was dispatched and no data was read.`;
  const firstFailing = summary.expressions.find((finding) => finding.status === "compile_error");
  const nextDraft = withLatestPreview(
    { ...ctx.getDraft(), latest_preview: null },
    {
      ok: green,
      step_id: firstFailing?.step_id ?? summary.steps.at(-1)?.id ?? "(end)",
      summary: line,
      preview: null,
      input: null,
      redacted: true,
      mode: "schema_only",
    },
    "dry_run_workflow",
    "workflow_previewed",
  );
  await ctx.setDraft(nextDraft);
  logger.info({
    module: "conversation_tool",
    action: "dry_run_workflow.sensitive_schema_only",
    msg: "sensitive draft checked structurally without reading or returning content",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    status: summary.status,
    steps: summary.counts.steps,
    expressions: summary.counts.expressions,
    compile_errors: summary.counts.compile_errors,
  });
  const nextActions = green
    ? ["save_workflow_draft"]
    : ["inspect_workflow_draft", "edit_workflow_patch"];
  const nextPrompt = green
    ? "Report that the structure was checked and the content was not, then call save_workflow_draft so the human approval gate decides. Live verification happens in the Cockpit by the signed-in person."
    : "Fix the listed compile errors via edit_workflow_patch, then re-run dry_run_workflow with mode schema_only. No content is available in chat.";
  return {
    ok: green,
    ...(green ? {} : { error_code: "preview_needs_repair", message: line }),
    data: buildLifecyclePayload(
      nextDraft,
      {
        summary: line,
        save_required: green,
        next_best_actions: nextActions,
        next_prompt: nextPrompt,
        handoff: SENSITIVE_LIVE_VERIFICATION_HANDOFF,
        schema_only_preview: summary,
      },
      { readOnly: true },
    ),
  };
}
