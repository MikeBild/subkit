import { HELD_PREVIEW_WARNING_CODE } from "../../execution/types.ts";
import type { ToolDiff } from "../json-patch-apply.ts";
import type { SyntheticToolResult } from "../persistence/auto-persist/synthetic.ts";
import { type CommitIntentKind, describePatchOps } from "../tools/ask-user/commit-intent.ts";
import type { ToolResult } from "../tools/index.ts";

const CHAT_DISPATCHABLE_INTENTS: ReadonlySet<CommitIntentKind> = new Set([
  "run_workflow",
  "commit_held_workflow_writes",
]);

const RETRYABLE_TOOLS: ReadonlySet<string> = new Set([
  "call_connector",
  "dry_run_workflow",
  "run_workflow",
  "probe_connector",
  "test_connector",
]);

const AUTH_FAILURE_CODE = /^(?:auth_failed|credential_(?:missing|invalid|expired))$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function elicitationInputKind(input: unknown): string | null {
  const kind = asRecord(input)?.kind;
  return typeof kind === "string" ? kind : null;
}

export function isWriteShapedConfirm(toolName: string, inputKind: string | null): boolean {
  return (
    toolName === "ask_user_confirm" &&
    (inputKind === "external_write" || inputKind === "save_workflow_draft")
  );
}

export function writeNotDispatchedSynthetic(inputKind: string): {
  synthetic: SyntheticToolResult;
  description: string;
} {
  return {
    synthetic: {
      tool: "ask_user_confirm",
      ok: false,
      error_code: "write_not_dispatched",
      message: `You approved a write confirmation (kind=${inputKind}) but it carried no commit_intent, so the harness performed NO write — nothing was persisted or executed. Do NOT report success. To actually perform it, re-issue ask_user_confirm with a commit_intent (e.g. {kind: "save_workflow_draft"} for a workflow step edit, {kind: "update_workflow_metadata", payload:{id,description}} for a metadata/description edit, {kind: "run_workflow", payload:{workflow_id,…}} for a run), OR call the underlying write tool now and confirm its result before telling the user it succeeded.`,
      next_best_actions:
        inputKind === "external_write"
          ? ["run_workflow", "ask_user_confirm"]
          : ["ask_user_confirm", "save_workflow_draft"],
      source: "harness_auto_persist",
    },
    description: `write confirmation approved without commit_intent (kind=${inputKind})`,
  };
}

export function chatRefusesIntent(surface: string | undefined, kind: CommitIntentKind): boolean {
  return surface === "chat" && !CHAT_DISPATCHABLE_INTENTS.has(kind);
}

export function chatReadonlySynthetic(
  toolName: string,
  kind: CommitIntentKind,
): SyntheticToolResult {
  return {
    tool: toolName,
    ok: false,
    error_code: "chat_readonly_channel",
    message: `This chat channel is read-only: the approved ${kind} was NOT performed — nothing was persisted or deleted. Do NOT report success. Tell the user to make this change via the subkit CLI or the web portal.`,
    next_best_actions: ["cannot_help"],
    source: "harness_auto_persist",
  };
}

export function readFormValues(output: unknown): Record<string, unknown> {
  if (!isPlainObject(output)) return {};
  return isPlainObject(output.values) ? output.values : output;
}

export function readSubmittedWorkflowInput(
  toolName: string,
  output: unknown,
): Record<string, unknown> {
  return toolName === "ask_user_form" ? readFormValues(output) : {};
}

export function readApprovedIndices(output: unknown, total: number): number[] | null {
  const raw = asRecord(output)?.approved_indices;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  for (const n of raw) {
    if (Number.isInteger(n) && n >= 0 && n < total) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export function readPatches(raw: unknown): ToolDiff[] | null {
  return Array.isArray(raw) && raw.length > 0 ? (raw as ToolDiff[]) : null;
}

export function noOpsAcceptedResult(rejected: ReadonlyArray<unknown>): ToolResult {
  return {
    ok: false,
    error_code: "no_ops_accepted",
    message:
      "no patch ops were accepted — the draft was left unchanged. Re-propose the edit or accept at least one op.",
    data: {
      applied_count: 0,
      skipped_count: rejected.length,
      skipped_ops: describePatchOps(rejected),
    },
  };
}

export function acceptedPatchResult(
  applyResult: ToolResult,
  approved: ReadonlyArray<unknown>,
  rejected: ReadonlyArray<unknown>,
): ToolResult {
  if (!applyResult.ok) return applyResult;
  const partial = rejected.length > 0;
  return {
    ...applyResult,
    data: {
      ...asRecord(applyResult.data),
      partial,
      applied_count: approved.length,
      skipped_count: rejected.length,
      applied_ops: describePatchOps(approved),
      ...(partial ? { skipped_ops: describePatchOps(rejected) } : {}),
    },
  };
}

export function staleVersionResult(
  workflowId: string,
  expected: string | undefined,
  current: string | null | undefined,
): ToolResult | null {
  if (!expected || expected === current) return null;
  return {
    ok: false,
    error_code: "workflow_version_not_active",
    message:
      "the prepared workflow version is no longer the active version; review the current version before running it",
    data: {
      workflow_id: workflowId,
      expected_workflow_version_id: expected,
      current_workflow_version_id: current ?? null,
    },
  };
}

export function mergeRunInput(
  normalizedPartial: unknown,
  fileInput: Record<string, unknown>,
  partial: Record<string, unknown>,
  answers: Record<string, unknown>,
): unknown {
  const scalarOrList =
    normalizedPartial !== undefined &&
    (typeof normalizedPartial !== "object" || Array.isArray(normalizedPartial));
  return scalarOrList ? normalizedPartial : { ...fileInput, ...partial, ...answers };
}

export function isRunInputObject(input: unknown): boolean {
  return isPlainObject(input);
}

export function missingRequiredFields(
  required: ReadonlyArray<string>,
  input: Record<string, unknown>,
): string[] {
  return required.filter((k) => {
    const v = input[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}

function codeList(keys: ReadonlyArray<string>): string {
  return keys.map((k) => `\`${k}\``).join(", ");
}

export function missingInputResult(p: {
  workflowId: string;
  workflowSlug: string;
  missing: string[];
  structured: string[];
  required: string[];
}): ToolResult {
  const one = p.missing.length === 1;
  const missingClause = `Workflow "${p.workflowSlug}" cannot run: required input ${
    one ? "field" : "fields"
  } ${codeList(p.missing)} ${one ? "is" : "are"} missing from the submitted input.`;
  const oneStructured = p.structured.length === 1;
  const pronoun = oneStructured ? "it" : "them";
  return {
    ok: false,
    error_code: "missing_workflow_input",
    message:
      p.structured.length > 0
        ? `${missingClause} ${codeList(p.structured)} ${
            oneStructured ? "is" : "are"
          } structured data (array or object) that a person cannot type into a form — never ask the user for ${pronoun} and never show raw JSON. Supply ${pronoun} in run_workflow input, or pass input_file from the tool that produced the data (for example export_diagnostic_context), then re-issue run_workflow. Nothing ran.`
        : `${missingClause} Re-issue run_workflow so it pauses with an ask_user_form that collects EVERY required field (${codeList(
            p.required,
          )}) — do NOT use a single ask_user_text; the harness runs the workflow with the submitted form values.`,
    data: {
      workflow_id: p.workflowId,
      workflow_slug: p.workflowSlug,
      missing_fields: p.missing,
      structured_fields: p.structured,
      required_fields: p.required,
    },
  };
}

export function inputFileUnavailableResult(
  workflowId: string,
  workflowSlug: string,
  detail: string,
): ToolResult {
  return {
    ok: false,
    error_code: "input_file_unavailable",
    message: `Workflow "${workflowSlug}" cannot run: the confirmed input file is no longer available in this conversation (${detail}). Nothing ran. Re-run the tool that produced the file, then re-issue run_workflow with the fresh input_file reference; do not ask the user to paste its contents.`,
    data: { workflow_id: workflowId, workflow_slug: workflowSlug },
  };
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runOutcomeResult<W extends { code: string }>(p: {
  run: { status: string; execution_id: string; output: unknown; warnings?: W[] };
  admitted: {
    hold_writes: boolean;
    workflow_version_id: unknown;
    execution_authority_id: unknown;
  };
  workflowId: string;
  workflowSlug: string;
  input: unknown;
}): ToolResult {
  const { run, admitted } = p;
  const heldPreview = run.warnings?.some((warning) => warning.code === HELD_PREVIEW_WARNING_CODE);
  return {
    ok: run.status === "succeeded" && !heldPreview,
    data: {
      status: run.status,
      execution_id: run.execution_id,
      workflow_id: p.workflowId,
      workflow_slug: p.workflowSlug,
      input: p.input,
      output: run.output,
      execute_writes: !admitted.hold_writes,
      hold_writes: admitted.hold_writes,
      workflow_version_id: admitted.workflow_version_id,
      execution_authority_id: admitted.execution_authority_id,
      ...(heldPreview
        ? {
            preview: true,
            writes_held: true,
            message: "Nothing was written. The supplied input does not authorize external effects.",
          }
        : {}),
      ...(run.warnings && run.warnings.length > 0 ? { warnings: run.warnings } : {}),
    },
  };
}

export function heldWorkflowSlug(approvedTool: string, prefix: string): string | null {
  return approvedTool.startsWith(prefix) ? approvedTool.slice(prefix.length) : null;
}

export function heldTargetMissing(
  workflowSlug: string | null,
  approvalId: string,
  approvedTool: string,
): { reason: string; result: ToolResult } {
  return {
    reason: workflowSlug ? "workflow_not_found" : "not_a_workflow_tool",
    result: {
      ok: false,
      error_code: workflowSlug ? "workflow_not_found" : "invalid_approval_target",
      message: workflowSlug
        ? `No saved workflow matches "${workflowSlug}" — it may have been renamed or deleted since the preview, so nothing was written. Re-run it to obtain a fresh preview.`
        : `Approval ${approvalId} was granted for ${approvedTool}, which is not a saved-workflow tool — nothing was written.`,
      data: workflowSlug ? { workflow_slug: workflowSlug } : {},
      next_best_actions: ["find_workflow", "list_workflows"],
    },
  };
}

export function replayInput(args: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(args).length > 0 ? args : null;
}

export function relayGrantResult(granted: boolean, tool: string): ToolResult {
  return granted
    ? {
        ok: true,
        data: {
          status: "approved",
          granted: true,
          tool,
          note: `The operator approved ${tool}. It has NOT run yet — the engine cannot perform an external MCP call for you. Re-issue ${tool} with __policy_confirmed: true and __policy_confirm_id set to the confirm_id you were given; the engine replays the arguments it already holds.`,
        },
      }
    : {
        ok: false,
        error_code: "approval_not_granted",
        message: `${tool} was not granted (the answer did not come from a person, or the approval expired). Nothing ran and nothing will — a person must approve it before ${tool} can be re-issued.`,
        data: { status: "not_granted", granted: false, tool },
      };
}

export function usesDirectConnectorApproval(
  tool: string,
): tool is "call_connector" | "probe_connector" {
  return tool === "call_connector" || tool === "probe_connector";
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function isAuthFailureOutput(output: unknown): boolean {
  const out = asRecord(output);
  const errorCode = out?.error_code;
  return (
    (typeof errorCode === "string" && AUTH_FAILURE_CODE.test(errorCode)) ||
    out?.status === "auth_failed"
  );
}

export interface ToolCallRow {
  tool: string;
  input: unknown;
  output: unknown;
}

export function findBlockedCallToRetry(
  rows: ReadonlyArray<ToolCallRow>,
  connectorId: string,
): { tool: string; input: unknown } | null {
  const blocked = rows.find(
    (row) =>
      RETRYABLE_TOOLS.has(row.tool) &&
      asRecord(row.input)?.connector_id === connectorId &&
      isAuthFailureOutput(row.output),
  );
  return blocked ? { tool: blocked.tool, input: blocked.input } : null;
}

export function credentialFlowResult(p: {
  oauthFlow: boolean;
  credentialPresent: boolean;
  connectorId: string | null;
  connectorSlug: string | null;
  blockedCallToRetry: { tool: string; input: unknown } | null;
}): ToolResult {
  const flow = p.oauthFlow ? "OAuth flow" : "Credential re-issue";
  const identity = {
    ...(p.connectorId ? { connector_id: p.connectorId } : {}),
    ...(p.connectorSlug ? { connector_slug: p.connectorSlug } : {}),
  };
  if (p.credentialPresent) {
    return {
      ok: true,
      data: {
        ...(p.oauthFlow ? { authenticated: true } : { reconnected: true }),
        ...identity,
        ...(p.blockedCallToRetry
          ? {
              blocked_call_to_retry: p.blockedCallToRetry,
              note: `${flow} completed. The saved credential is now active. Retry the call that was blocked on this connector: ${p.blockedCallToRetry.tool}(...). The same input shape is in blocked_call_to_retry.input — re-issue verbatim.`,
            }
          : {
              note: `${flow} completed. The saved credential is now active; retry the call_connector / dry_run_workflow / run_workflow that was blocked on this connector.`,
            }),
      },
    };
  }
  return {
    ok: false,
    error_code: p.oauthFlow ? "oauth_not_completed" : "credential_reissue_not_completed",
    message: p.oauthFlow
      ? "No OAuth credential was minted for this connector — the provider never completed the authorization callback, so the connector is NOT authenticated. Do NOT retry the connector or report success. Causes: the authorization URL was not actually completed in the browser, or the provider rejected it (the redirect URI is not registered in the provider app, or a requested scope is not approved). Have the operator open the authorization URL, finish the consent so the provider redirects back to the engine callback, THEN call authenticate_oauth again to resume waiting for the token."
      : "No replacement credential is stored for this connector. The credential-setup flow was not completed, so the connector is NOT reconnected. Do not retry the connector or report success; run request_connector_reauth again and complete the URL elicitation.",
    data: {
      ...(p.oauthFlow ? { authenticated: false } : { reconnected: false }),
      ...identity,
    },
    next_best_actions: [p.oauthFlow ? "authenticate_oauth" : "request_connector_reauth"],
  };
}

export function connectorEnvironment(environment: unknown): "dev" | "prod" {
  return environment === "prod" ? "prod" : "dev";
}

export function pgErrorFields(err: unknown): {
  pg_code: unknown;
  pg_constraint: unknown;
  pg_detail: unknown;
} {
  const pgErr = err as { code?: unknown; constraint?: unknown; detail?: unknown } | null;
  return {
    pg_code: pgErr?.code ?? null,
    pg_constraint: pgErr?.constraint ?? null,
    pg_detail: pgErr?.detail ?? null,
  };
}

export function dispatchErrorSynthetic(
  tool: string,
  translated: { error_code: string; message: string; next_best_actions: string[] },
): SyntheticToolResult {
  return {
    tool,
    ok: false,
    error_code: translated.error_code,
    message: translated.message,
    next_best_actions: translated.next_best_actions,
    source: "harness_auto_persist",
  };
}

export function gatedCallOutcome(result: ToolResult, prepared: boolean): "ok" | "error" {
  return result.ok || prepared ? "ok" : "error";
}

export function completionAudit(p: {
  kind: CommitIntentKind;
  toolName: string;
  result: ToolResult;
  prepared: boolean;
  conversationId: string;
}): {
  resumed: boolean;
  reason: string;
  result: "success" | "error";
  metadata: Record<string, unknown>;
} {
  const resumed = p.kind === "run_workflow";
  const success = p.result.ok || p.prepared;
  return {
    resumed,
    reason: resumed ? "workflow_input_submitted" : "auto_persist_on_confirmation",
    result: success ? "success" : "error",
    metadata: {
      commit_intent_kind: p.kind,
      tool: p.toolName,
      ok: p.result.ok,
      ...(p.result.pause ? { follow_up_elicitation_id: p.result.pause.elicitation_id } : {}),
      ...(p.prepared ? { preparation: true } : {}),
      conversation_id: p.conversationId,
      ...(success ? {} : { error_code: (p.result as { error_code?: string }).error_code ?? null }),
    },
  };
}
