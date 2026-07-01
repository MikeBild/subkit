// Confirmation / elicitation / dedupe helpers used by the wrapper.
// Pure functions only — no side effects, no DB access. They translate
// tool names + raw args + assistant text into commit-intent shapes,
// risk metadata, and prose-confirmation matches.

import { normalizeWorkflowInput } from "../workflow-input-normalize.ts";

export function confirmationMetadataForTool(
  toolName: string,
  input: unknown,
): {
  risk_level: "low" | "medium" | "high" | "critical";
  target_label?: string;
  reversible: boolean;
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const slug = typeof obj.slug === "string" ? obj.slug : null;
  // `run_workflow` accepts `workflow` (slug or uuid); legacy state-write
  // tools (delete_workflow, update_workflow) carry `workflow_id`. Either
  // is a useful target label when surfacing the risk envelope.
  const workflow = typeof obj.workflow === "string" ? obj.workflow : null;
  const workflowId = typeof obj.workflow_id === "string" ? obj.workflow_id : null;
  const connectorId = typeof obj.connector_id === "string" ? obj.connector_id : null;
  const environment = typeof obj.environment === "string" ? obj.environment : null;
  const target = slug ?? workflow ?? workflowId ?? connectorId ?? null;
  const isDelete = toolName.startsWith("delete_") || toolName.startsWith("revoke_");
  const isProd = environment === "prod";
  const riskLevel = isDelete ? "critical" : isProd ? "high" : "medium";
  return {
    risk_level: riskLevel,
    ...(target ? { target_label: `${toolName}: ${target}` } : {}),
    reversible: !isDelete,
  };
}

/**
 * Map tenant_write tools to the `commit_intent.kind` value the harness
 * auto-persist dispatcher routes on. `buildPolicyGateCommitIntent`
 * attaches this carrier to the policy-gate elicitation so the write is
 * applied atomically the moment the operator confirms (no LLM re-issue).
 * Also used to label the forensic `policy.gate_*` logs.
 *
 * NOTE: this is NOT a confirm-dedup key. The confirm decision is the
 * deterministic `decideConfirm` rule (see `confirm-decision.ts`); the
 * only durable-approval shortcut left is the save path's
 * `findPriorSaveWorkflowApproval`.
 *
 * Kept in sync with `apps/engine/src/conversations/tools/ask-user/commit-intent.ts`.
 */
export function mapToolToCommitIntentKind(tool: string): string | null {
  switch (tool) {
    case "save_workflow_draft":
      return "save_workflow_draft";
    case "save_connector_draft":
      return "save_connector_draft";
    case "run_workflow":
      return "run_workflow";
    case "update_connector":
      return "update_connector";
    case "update_workflow":
      return "update_workflow";
    // Pre-fix (session 975a64b0): delete_connector / delete_workflow
    // policy-gate elicitations carried NO commit_intent. The user
    // clicked "approve", auto-persist found no intent, logged
    // `auto_persist.skipped`, and the delete silently never ran.
    // The LLM then claimed "Connector deleted" (hallucination) and
    // moved on — leaving the row alive. The next save_connector_draft
    // for the same slug then crashed with 23505 unique-violation
    // (16:37:21).
    case "delete_connector":
      return "delete_connector";
    case "delete_workflow":
      return "delete_workflow";
    case "create_api_key":
      return "create_api_key";
    default:
      return null;
  }
}

/**
 * Top-level `input.kind` to stamp on a policy-gate elicitation so the
 * tool's downstream prior-approval gate (e.g. `commit-workflow.ts`'s
 * SQL filter `(input ->> 'kind') = 'save_workflow_draft'`) finds the resolved
 * row when the LLM re-issues the call with `__policy_confirmed: true`.
 *
 * For `save_workflow_draft` we MUST use `"save_workflow_draft"` (not `"external_write"`)
 * — without this the policy-gate elicitation would never satisfy the
 * inner `commitWorkflowAtomic` prior-approval check, and a re-issue
 * would loop indefinitely with `error: no_prior_approval`. Other
 * persisting tools fall back to `"external_write"` — they do not gate
 * themselves on a specific `input.kind` value.
 */
export function topLevelElicitationKindForTool(
  tool: string,
): "save_workflow_draft" | "external_write" | "generic" {
  if (tool === "save_workflow_draft") return "save_workflow_draft";
  return "external_write";
}

/**
 * Sentinel `input.kind` stamped on the post-execution review
 * elicitation the `confirm_after_execution` policy mode raises.
 *
 * This is NOT a member of the `ask_user_confirm` schema's `kind` enum
 * (`save_workflow_draft | external_write | generic`) — it is an
 * out-of-band marker the post-execution-review path uses to tag a
 * confirm whose subject is a result that has ALREADY been produced.
 *
 * `review_after_execution` is ADVISORY-ONLY by design: the underlying
 * `tenant_write` tools are mostly idempotent and non-rollbackable, so a
 * declined review has no automatic rollback path. `maybeAutoPersistFromElicitation`
 * therefore returns early for these (no `commit_intent` is attached),
 * and a decline is logged + surfaced for the model to react to on the
 * next turn — it does not trigger a harness write. The exported
 * constant exists so this sentinel is referenced by name everywhere
 * instead of as a bare magic string.
 */
export const REVIEW_AFTER_EXECUTION_KIND = "review_after_execution" as const;

/**
 * Build the optional `commit_intent` carrier the harness reads in
 * `maybeAutoPersistFromElicitation` to atomically persist the write
 * the moment the operator confirms — no LLM re-issue required.
 *
 * Returns `null` when we have no shape contract for the tool's payload
 * yet; the call falls back to the legacy LLM-re-issue path
 * (`__policy_confirmed: true`).
 */
export function buildPolicyGateCommitIntent(
  tool: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> | null {
  const intentKind = mapToolToCommitIntentKind(tool);
  if (!intentKind) return null;
  if (intentKind === "save_workflow_draft") {
    const targetId =
      typeof rawArgs.target_workflow_id === "string" ? rawArgs.target_workflow_id : undefined;
    const forceCommit = rawArgs.force_commit === true;
    return {
      kind: "save_workflow_draft",
      payload: {
        ...(targetId ? { target_workflow_id: targetId } : {}),
        ...(forceCommit ? { force_commit: true } : {}),
      },
      description: "Save the current workflow draft.",
    };
  }
  if (intentKind === "save_connector_draft") {
    const env = typeof rawArgs.environment === "string" ? rawArgs.environment : "dev";
    return {
      kind: "save_connector_draft",
      payload: { environment: env },
      description: "Save the current connector draft.",
    };
  }
  if (intentKind === "delete_connector") {
    const id = typeof rawArgs.id === "string" ? rawArgs.id : null;
    if (!id) return null;
    return {
      kind: "delete_connector",
      payload: { id },
      description: "Permanently delete this connector.",
    };
  }
  if (intentKind === "delete_workflow") {
    const id = typeof rawArgs.id === "string" ? rawArgs.id : null;
    if (!id) return null;
    return {
      kind: "delete_workflow",
      payload: { id },
      description: "Permanently delete this workflow.",
    };
  }
  if (intentKind === "create_api_key") {
    const {
      __policy_confirmed: _policyConfirmed,
      _meta,
      ...payload
    } = rawArgs as Record<string, unknown>;
    return {
      kind: "create_api_key",
      payload,
      description: "Create a new API key.",
    };
  }
  if (intentKind === "run_workflow") {
    const workflow = typeof rawArgs.workflow === "string" ? rawArgs.workflow : null;
    const workflowId =
      typeof rawArgs.workflow_id === "string" ? rawArgs.workflow_id : (workflow ?? null);
    if (!workflowId) return null;
    const environment = typeof rawArgs.environment === "string" ? rawArgs.environment : "dev";
    return {
      kind: "run_workflow",
      payload: {
        workflow_id: workflowId,
        ...(workflow ? { workflow_slug: workflow, workflow } : {}),
        environment,
        ...(rawArgs.input !== undefined
          ? { input_partial: normalizeWorkflowInput(rawArgs.input) }
          : {}),
        ...(rawArgs.execute_writes === true ? { execute_writes: true } : {}),
        ...(rawArgs.include_step_trace === true ? { include_step_trace: true } : {}),
      },
      description: `Run workflow ${workflow ?? workflowId} in ${environment}.`,
    };
  }
  // update_* — payload shapes still owned by the LLM-driven
  // ask_user_confirm path; the policy-gate fallback for these uses the
  // re-issue contract.
  return null;
}

/**
 * Attach summary fields so `conversation.tool.succeeded/failed` logs
 * carry at least some shape context regardless of which tool emitted.
 */
export function summarizeToolData(data: unknown): Record<string, number | string | boolean> {
  if (data === null || data === undefined) return {};
  if (Array.isArray(data)) return { data_length: data.length };
  if (typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const out: Record<string, number | string | boolean> = {};
  if (Array.isArray(obj.errors)) out.error_count = (obj.errors as unknown[]).length;
  if (Array.isArray(obj.hits)) out.hit_count = (obj.hits as unknown[]).length;
  if (Array.isArray(obj.skills)) out.skill_count = (obj.skills as unknown[]).length;
  if (Array.isArray(obj.items)) out.item_count = (obj.items as unknown[]).length;
  if (typeof obj.steps === "number") out.steps = obj.steps;
  if (typeof obj.step_count === "number") out.step_count = obj.step_count;
  if (typeof obj.workflow_id === "string") out.workflow_id = obj.workflow_id;
  if (typeof obj.connector_id === "string") out.connector_id = obj.connector_id;
  if (typeof obj.skill_id === "string") out.skill_id = obj.skill_id;
  if (typeof obj.step_id === "string") out.step_id = obj.step_id;
  if (typeof obj.last_step_id === "string") out.last_step_id = obj.last_step_id;
  if (typeof obj.step_type === "string") out.step_type = obj.step_type;
  if (typeof obj.slug === "string") out.slug = obj.slug;
  if (typeof obj.approval_id === "string") out.approval_id = obj.approval_id;
  if (typeof obj.reason === "string") out.reason = obj.reason;
  if (typeof obj.error === "string") out.error = obj.error;
  if (typeof obj.replaced === "boolean") out.replaced = obj.replaced;
  out.data_keys = Object.keys(obj).length;
  return out;
}

/**
 * Lift the rejection reason from a structured `ok:false` ToolResult into log
 * fields. The reason lives at the TOP LEVEL (`error_code`/`message`) on the
 * ToolResult, NOT inside `data` — so `summarizeToolData` (which inspects
 * `data`) misses it. Without this, `conversation.tool.failed` logged a bare
 * `ok:false` carrying only `data_keys`, leaving an operator with no WHY (the
 * production `ask_user_form` / `probe_connector_draft` credential_form_mismatch
 * failures read as silent). `message` maps to the log's `error` field so it
 * lines up with the throw-path's `error: msg`. Returns `{}` for an `ok:true`
 * result or one with no structured reason.
 */
export function summarizeToolFailure(result: {
  ok: boolean;
  error_code?: string;
  message?: string;
  data?: unknown;
}): Record<string, string> {
  if (result.ok) return {};
  const out: Record<string, string> = {};
  // Most authoring tools pack the rejection reason INTO `data` (e.g.
  // run_workflow's `data.error_code`, dry_run_workflow's `data.summary`)
  // rather than at the top level — without a `data` fallback the tool.failed
  // log read `undefined` for every one of them. Read top-level first (the
  // canonical place), then fall back to the well-known `data` fields so the
  // log carries WHY regardless of where the tool put it.
  const data = (result.data ?? {}) as {
    error_code?: unknown;
    reason?: unknown;
    message?: unknown;
    summary?: unknown;
    error?: unknown;
  };
  const code =
    result.error_code ??
    (typeof data.error_code === "string" ? data.error_code : undefined) ??
    (typeof data.reason === "string" ? data.reason : undefined);
  const message =
    result.message ??
    (typeof data.message === "string" ? data.message : undefined) ??
    (typeof data.summary === "string" ? data.summary : undefined) ??
    (typeof data.error === "string" ? data.error : undefined);
  // Bound both fields: a tool may interpolate an arbitrarily large payload
  // (e.g. an upstream response body) into its rejection message, and this
  // lands verbatim in the structured log. The field-level redactor still
  // scrubs credential-shaped substrings; the cap just stops log bloat.
  if (typeof code === "string") out.error_code = code.slice(0, 80);
  if (typeof message === "string") out.error = message.slice(0, 500);
  return out;
}
