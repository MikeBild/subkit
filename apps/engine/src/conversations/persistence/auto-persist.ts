// Harness-side auto-persist dispatcher (PR11/PR12).
//
// When an `ask_user_form` or `ask_user_confirm` carries a
// `commit_intent`, the harness applies the proposed write atomically
// once the operator submits. The LLM does NOT need to call the
// underlying tool (save_connector_draft / save_workflow_draft / delete_*)
// afterwards — the synthetic tool result the harness injects has
// `source: "harness_auto_persist"`, so the LLM's next turn sees the
// persistence as a normal tool-result message.
//
// Contract:
//   - This module owns the dispatch decision: which kind to run,
//     how the form values map onto the underlying call, and what the
//     synthetic tool result looks like.
//   - Atomicity lives in the underlying helpers
//     (`saveConnectorAtomic`, `commitWorkflowAtomic`, `deleteConnector`,
//     `deleteWorkflow`). This module is the orchestrator.
//   - Audit lives in two places:
//       1. The underlying helper writes its existing audit row
//          (e.g. `connector.created`) — that row stays untouched.
//       2. THIS module writes a second audit row tagged
//          `actor: <operator>, reason: auto_persist_on_confirmation,
//          commit_intent_kind: <kind>` so operators can distinguish a
//          harness-issued save from an LLM-issued one. (The atomic
//          helpers also emit a `source: "harness_auto_persist"` audit
//          when `emitAutoPersistAudit: true` is passed — together that
//          gives a full trail.)

import { eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { logger } from "../../logging/logger.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import { COMMIT_INTENT_KINDS, type CommitIntent } from "../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { inspectConnectorDraftTool } from "../tools/inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../tools/probe-connector-draft.ts";
import { validateConnectorDraftTool } from "../tools/validate-connector-draft.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";
import { setDraftCredential } from "./draft-credential-cache.ts";
import { type AtomicCredentialInput, saveConnectorAtomic } from "./save-connector.ts";

/**
 * Shape of the synthetic tool result the harness injects into the
 * conversation event log. The LLM's next turn sees this as a regular
 * tool-result message, with the distinguishing `source` field set to
 * `"harness_auto_persist"` so logs and tests can tell synthetic from
 * real LLM-issued tool calls.
 */
export interface SyntheticToolResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error_code?: string;
  message?: string;
  next_best_actions?: string[];
  source: "harness_auto_persist";
}

export interface AutoPersistInput {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /** The carrier elicitation's `output` after `resolveElicitation`. */
  elicitation_output: unknown;
  /** The persisted carrier — read from `conversation_elicitations`. */
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
  };
  db: Db;
}

export interface AutoPersistDispatch {
  /** True if a `commit_intent` was found and dispatched. */
  dispatched: boolean;
  /** When dispatched, the synthetic tool result we injected. */
  synthetic_result?: SyntheticToolResult;
  /** When dispatched, the conversation_tool_calls row id we wrote. */
  synthetic_tool_call_id?: string;
}

/**
 * Inspect a resumed elicitation; if the carrier `input.commit_intent`
 * is set, dispatch the corresponding internal write, audit it, and
 * inject a synthetic tool-call row + tool-result row + tool message
 * into the conversation timeline. Returns `{dispatched: false}` when
 * there is no commit_intent, or when the operator declined / submitted
 * an empty form (we still inject a synthetic decline result so the
 * LLM's next turn carries the signal).
 */
export async function maybeAutoPersistFromElicitation(
  p: AutoPersistInput,
): Promise<AutoPersistDispatch> {
  const intent = extractCommitIntent(p.elicitation.input);
  if (!intent) {
    // Forensic log: the elicitation resolved but carried no
    // commit_intent so the harness has nothing to dispatch. Pre-fix
    // this branch was completely silent — operators triaging "I
    // approved but nothing got saved" had to grep for the absence
    // of a workflow.created row to even notice the harness no-op.
    // We surface the elicitation kind so the next investigation can
    // immediately tell whether the LLM forgot to attach commit_intent
    // (kind=external_write/generic) or whether we were called with
    // an unrelated elicitation type (kind=ask_user_text/etc).
    const elicitationInputKind =
      p.elicitation.input && typeof p.elicitation.input === "object" && p.elicitation.input !== null
        ? ((p.elicitation.input as { kind?: unknown }).kind ?? null)
        : null;
    logger.info({
      module: "conversation_persistence",
      action: "auto_persist.skipped",
      msg: "elicitation resolved without commit_intent — no harness write dispatched",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      elicitation_tool_name: p.elicitation.tool_name,
      elicitation_input_kind:
        typeof elicitationInputKind === "string" ? elicitationInputKind : null,
    });
    return { dispatched: false };
  }

  const declineCheck = checkDecline(p.elicitation.tool_name, p.elicitation_output);
  if (declineCheck) {
    const synthetic = buildDeclineSynthetic(intent, declineCheck);
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  // Build a tool context the underlying atomic helpers can use.
  const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  let liveDraft = draft;
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      actor_type: p.actor_id ? "user" : "system",
      db: p.db,
    }),
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      liveDraft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
  };

  let result: ToolResult;
  let toolName: string;
  try {
    switch (intent.kind) {
      case "save_connector_draft": {
        toolName = "save_connector_draft";
        const credential = mergeFormIntoCredential(intent, p.elicitation_output);
        const environment = readEnvironment(intent);
        // Probe-then-save: when the connector hasn't been probed yet
        // and its template declares a probe_endpoint, run the probe
        // before the save so the form-submit acts as one transactional
        // approval. Without this the save bounces off the probe gate
        // (`save-connector.ts:probeFailed`) and the LLM has to retry
        // through a second `ask_user_confirm`. The credential cache
        // was populated by `maybeCacheDraftCredentialFromElicitation`
        // before this dispatcher ran, so the probe sees auth.
        await maybeAutoProbeForSave(ctx, p.tenant_id);
        await maybeAutoFreshenCheckpointsForSave(ctx);
        result = await saveConnectorAtomic({
          ctx,
          environment,
          ...(credential ? { credential } : {}),
          reason: "auto_persist_on_confirmation",
          emitAutoPersistAudit: true,
          commitIntentKind: intent.kind,
        });
        break;
      }
      case "save_workflow_draft": {
        toolName = "save_workflow_draft";
        const targetId = readString(intent.payload, "target_workflow_id");
        // The LLM declares force_commit in the commit_intent payload
        // when proposing to commit despite a failed preview. Honour it
        // here so a single operator confirmation suffices — without
        // this, the preview gate in commitWorkflowAtomic blocks the
        // auto-persist and the LLM has to retry through a separate
        // save_workflow_draft call (the "approve twice" symptom).
        const forceCommit = intent.payload.force_commit === true;
        result = await commitWorkflowAtomic({
          ctx,
          ...(targetId ? { target_workflow_id: targetId } : {}),
          ...(forceCommit ? { forceCommit: true } : {}),
          skipPriorApprovalCheck: true,
          reason: "auto_persist_on_confirmation",
          emitAutoPersistAudit: true,
          commitIntentKind: intent.kind,
        });
        break;
      }
      case "delete_connector": {
        toolName = "delete_connector";
        result = await dispatchDeleteConnector(ctx, intent);
        break;
      }
      case "delete_workflow": {
        toolName = "delete_workflow";
        result = await dispatchDeleteWorkflow(ctx, intent);
        break;
      }
      case "rollback_after_execute": {
        toolName = "rollback_after_execute";
        result = await dispatchRollbackSkipped(ctx, intent);
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noExplicitAny: pg errors carry .code / .constraint
    const pgErr = err as any;
    logger.error({
      module: "auto-persist",
      action: "dispatch.threw",
      msg: "auto-persist dispatcher threw — surfacing structured error to the LLM",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      commit_intent_kind: intent.kind,
      pg_code: pgErr?.code ?? null,
      pg_constraint: pgErr?.constraint ?? null,
      pg_detail: pgErr?.detail ?? null,
      error: msg,
    });
    // Translate Postgres errors into actionable error_codes so the
    // LLM has a concrete recovery path instead of throwing
    // `cannot_help` and dead-ending the chat (session abeefb33: a
    // 23505 unique_violation on `connectors_tenant_slug_env_key`
    // surfaced as "database error" → cannot_help → conversation
    // ended on a colon with no question for the user).
    const translated = translateAutoPersistError(err, intent.kind);
    const synthetic: SyntheticToolResult = {
      tool: intentToolName(intent.kind),
      ok: false,
      error_code: translated.error_code,
      message: translated.message,
      next_best_actions: translated.next_best_actions,
      source: "harness_auto_persist",
    };
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  // Audit the write itself. The atomic helper already wrote the
  // canonical resource audit row (e.g. `connector.created`); this
  // second row tags the dispatch path so operators can filter on
  // `reason: auto_persist_on_confirmation`.
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.APPROVAL_APPROVED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: result.ok ? "success" : "denied",
      reason: "auto_persist_on_confirmation",
      metadata: {
        commit_intent_kind: intent.kind,
        tool: toolName,
        ok: result.ok,
        conversation_id: p.conversation_id,
      },
    },
    p.db,
  );

  const synthetic = buildSyntheticFromResult(toolName, result);
  const callId = await injectSyntheticToolCall({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    synthetic,
    intent,
  });
  return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
}

function extractCommitIntent(input: unknown): CommitIntent | null {
  if (!input || typeof input !== "object") return null;
  const ci = (input as { commit_intent?: unknown }).commit_intent;
  if (!ci || typeof ci !== "object") return null;
  const obj = ci as Record<string, unknown>;
  if (typeof obj.kind !== "string") return null;
  if (!COMMIT_INTENT_KINDS.includes(obj.kind as CommitIntent["kind"])) return null;
  if (typeof obj.description !== "string") return null;
  if (!obj.payload || typeof obj.payload !== "object") return null;
  return {
    kind: obj.kind as CommitIntent["kind"],
    payload: obj.payload as Record<string, unknown>,
    description: obj.description,
  };
}

interface DeclineSignal {
  error_code: "user_declined" | "empty_submission";
  reason: string;
}

function checkDecline(toolName: string, output: unknown): DeclineSignal | null {
  if (output === null || output === undefined) {
    return { error_code: "user_declined", reason: "operator_dismissed_elicitation" };
  }
  const out = (output ?? {}) as Record<string, unknown>;
  if (toolName === "ask_user_confirm") {
    if (out.confirmed === false || out.declined === true) {
      return { error_code: "user_declined", reason: "operator_rejected_confirmation" };
    }
    if (out.confirmed !== true) {
      return { error_code: "user_declined", reason: "operator_did_not_confirm" };
    }
    return null;
  }
  if (toolName === "ask_user_form") {
    const values =
      typeof out.values === "object" && out.values !== null
        ? (out.values as Record<string, unknown>)
        : out;
    const hasContent = Object.values(values).some((v) => v !== null && v !== undefined && v !== "");
    if (!hasContent) {
      return { error_code: "empty_submission", reason: "operator_submitted_empty_form" };
    }
    return null;
  }
  return null;
}

function buildDeclineSynthetic(intent: CommitIntent, signal: DeclineSignal): SyntheticToolResult {
  return {
    tool: intentToolName(intent.kind),
    ok: false,
    error_code: signal.error_code,
    message:
      signal.error_code === "user_declined"
        ? `operator declined the ${intent.kind} action — do not retry without asking again`
        : "operator submitted an empty form — re-ask only if you have a different question to pose",
    next_best_actions: ["ask_user", "cannot_help"],
    source: "harness_auto_persist",
  };
}

function buildSyntheticFromResult(toolName: string, result: ToolResult): SyntheticToolResult {
  if (result.ok) {
    return {
      tool: toolName,
      ok: true,
      data: result.data,
      source: "harness_auto_persist",
    };
  }
  return {
    tool: toolName,
    ok: false,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.next_best_actions !== undefined
      ? { next_best_actions: result.next_best_actions }
      : {}),
    source: "harness_auto_persist",
  };
}

/**
 * Map a thrown Postgres / runtime error to a structured envelope the
 * LLM can act on. Without this every dispatch failure surfaced as the
 * vague "database error" prose (session abeefb33) and the LLM fell
 * back to `cannot_help`, leaving the user staring at a colon with no
 * recovery path. The mapping uses Postgres SQLSTATE codes when
 * available (`pg` exposes them via `err.code`) plus regex fallbacks
 * on the message.
 */
/** Label hint passed to `translateAutoPersistError` so it can pick
 *  resource-specific recovery actions. Accepts the canonical
 *  CommitIntent kinds plus the bare resource labels used by direct
 *  tool paths (`update_connector`, `update_workflow`). When the
 *  caller's tool doesn't fit any of these, the translator falls
 *  back to a generic resource label. */
export type ErrorTranslationContext = CommitIntent["kind"] | "update_connector" | "update_workflow";

export function translateAutoPersistError(
  err: unknown,
  intentKind: ErrorTranslationContext,
): { error_code: string; message: string; next_best_actions: string[] } {
  const msg = err instanceof Error ? err.message : String(err);
  // biome-ignore lint/suspicious/noExplicitAny: pg errors carry .code
  const code = (err as any)?.code;
  const detail =
    typeof (err as { detail?: unknown })?.detail === "string"
      ? ((err as { detail: string }).detail as string)
      : null;
  const lower = msg.toLowerCase();
  // 23505 — unique_violation. The dominant cause for re-create after
  // soft-delete (`connectors_tenant_slug_env_key` /
  // `workflows_tenant_slug_active_key`) and for genuine slug
  // collisions on a still-active row.
  if (code === "23505" || /unique constraint|duplicate key|already exists/i.test(lower)) {
    const isConnector =
      intentKind === "save_connector_draft" ||
      intentKind === "update_connector" ||
      intentKind === "delete_connector";
    const isWorkflow =
      intentKind === "save_workflow_draft" ||
      intentKind === "update_workflow" ||
      intentKind === "delete_workflow";
    const resource = isConnector ? "connector" : isWorkflow ? "workflow" : "resource";
    return {
      error_code: "slug_already_in_use",
      message: `A ${resource} with this slug already exists in the tenant. List existing ${resource}s (\`list_${resource === "connector" ? "connectors" : "workflows"}\`) and either choose a different slug, restore the existing row, or update it in place. Detail: ${detail ?? msg}`,
      next_best_actions:
        resource === "connector"
          ? ["list_connectors", "get_connector", "update_connector"]
          : ["list_workflows", "get_workflow", "update_workflow"],
    };
  }
  // 23503 — foreign_key_violation. Common when deleting something
  // that's still referenced.
  if (code === "23503" || /foreign key|violates foreign key/i.test(lower)) {
    return {
      error_code: "in_use_by_dependent_rows",
      message: `Cannot complete the operation because the resource is still referenced by another row. Detail: ${detail ?? msg}`,
      next_best_actions: ["list_executions", "list_workflows", "list_connectors", "ask_user_text"],
    };
  }
  // 23502 — not_null_violation. Authoring layer bug; surface to LLM
  // with the column name so it can repair the draft.
  if (code === "23502" || /null value|violates not-null/i.test(lower)) {
    return {
      error_code: "missing_required_field",
      message: `A required field is missing on the draft. Detail: ${detail ?? msg}`,
      next_best_actions: ["inspect_connector_draft", "inspect_workflow_draft", "validate_draft"],
    };
  }
  // 22P02 — invalid_text_representation (often "uuid syntax").
  if (code === "22P02" || /invalid input syntax/i.test(lower)) {
    return {
      error_code: "invalid_input_format",
      message: `An input value has the wrong format (likely a malformed uuid or enum). Detail: ${detail ?? msg}`,
      next_best_actions: ["inspect_authoring_context", "inspect_connector_draft"],
    };
  }
  // Fallback — truly unexpected. Keep `auto_persist_failed` as the
  // signal but include the verbatim message so the LLM can paraphrase
  // SOMETHING actionable to the user instead of dead-ending.
  return {
    error_code: "auto_persist_failed",
    message: `Unexpected error while persisting the ${intentKind} write. ${msg}. Surface this as a clear question for the user: report what failed and ask whether to retry, change inputs, or escalate.`,
    next_best_actions: ["ask_user_text", "cannot_help"],
  };
}

function intentToolName(kind: CommitIntent["kind"]): string {
  switch (kind) {
    case "save_connector_draft":
      return "save_connector_draft";
    case "save_workflow_draft":
      return "save_workflow_draft";
    case "delete_connector":
      return "delete_connector";
    case "delete_workflow":
      return "delete_workflow";
    case "rollback_after_execute":
      return "rollback_after_execute";
  }
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readEnvironment(intent: CommitIntent): "dev" | "prod" {
  const env = readString(intent.payload, "environment");
  return env === "prod" ? "prod" : "dev";
}

/**
 * Merge the form values into `commit_intent.payload.credential`. The
 * LLM declares the credential _shape_ in `payload.credential` (e.g.
 * `{ mode: "bearer" }`) and the operator types the secret into the
 * masked form field; this helper splices the field into the shape.
 *
 * Recognised form-field names (matched case-insensitively) for each
 * credential mode:
 *   bearer  → `token`
 *   basic   → `username`, `password`
 *   header  → `header_name`, `header_value`
 *   query   → `param`, `value`
 */
function mergeFormIntoCredential(
  intent: CommitIntent,
  output: unknown,
): AtomicCredentialInput | null {
  const credentialSeed = (intent.payload.credential ?? {}) as Record<string, unknown>;
  const seedMode = typeof credentialSeed.mode === "string" ? credentialSeed.mode : null;
  if (!seedMode) return null;
  return extractCredentialFromFormOutput(seedMode, credentialSeed, output);
}

/**
 * Pure extraction: given a target credential mode and a form output,
 * return an `AtomicCredentialInput` if the form contains values that
 * match the mode's required fields. `seedOverrides` lets the caller
 * pre-supply values (e.g. the LLM-declared `header_name` for a
 * `header`-auth connector) so only the secret has to come from the
 * form.
 *
 * Exported so the elicitation-resume path can populate the draft
 * credential cache without going through `commit_intent` — see
 * `cacheDraftCredentialFromFormOutput` and
 * `apps/engine/src/conversations/service.ts:respondElicitation`.
 */
export function extractCredentialFromFormOutput(
  seedMode: string,
  seedOverrides: Record<string, unknown>,
  output: unknown,
): AtomicCredentialInput | null {
  // The LLM frequently emits `mode: "oauth2"` in the commit_intent —
  // it sees the connector's `auth_type: "oauth2"` and copies it. But
  // there is no concrete "oauth2" credential ROW shape — only the
  // grant-specific bootstrap shapes (cognito_user_password, …) and the
  // post-exchange `mode: "oauth2"` row that the engine produces
  // internally. Pre-fix this fell through to `default → null` and the
  // form output silently produced no credential, leading to a saved
  // connector with no auth → 401 on every call (session bab50df1).
  // Promote `oauth2` to the matching grant-specific bootstrap based on
  // the seed override hints (or, when no hint is present, fall back to
  // RFC 6749 password-grant which uses the same {username,password}
  // shape).
  if (seedMode === "oauth2") {
    const grantHint =
      typeof seedOverrides.grant_type === "string" ? seedOverrides.grant_type : null;
    if (
      grantHint === "cognito_user_password" ||
      typeof seedOverrides.aws_region === "string" ||
      typeof seedOverrides.cognito_client_id === "string"
    ) {
      seedMode = "cognito_user_password";
    }
    // Other grant_types (authorization_code, client_credentials, jwt_bearer,
    // device_code) don't go through the form-submit credential path — they
    // run their own dedicated flows. Falling through to default returns
    // null which surfaces as `credential_required` to the caller.
  }
  const out = (output ?? {}) as Record<string, unknown>;
  const values =
    typeof out.values === "object" && out.values !== null
      ? (out.values as Record<string, unknown>)
      : out;
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const exact = values[k];
      if (typeof exact === "string" && exact.length > 0) return exact;
    }
    // Case-insensitive fallback so we tolerate `Token`, `API_KEY`,
    // `password`/`Password` variations in form field names.
    const lower = new Map<string, string>();
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === "string" && v.length > 0) lower.set(k.toLowerCase(), v);
    }
    for (const k of keys) {
      const v = lower.get(k.toLowerCase());
      if (v) return v;
    }
    return null;
  };
  switch (seedMode) {
    case "bearer": {
      const token =
        (typeof seedOverrides.token === "string" && seedOverrides.token.length > 0
          ? seedOverrides.token
          : null) ?? pick(["token", "api_key", "apikey", "secret", "key"]);
      if (!token) return null;
      return { mode: "bearer", token };
    }
    case "basic": {
      const username =
        (typeof seedOverrides.username === "string" && seedOverrides.username.length > 0
          ? seedOverrides.username
          : null) ?? pick(["username", "user", "login"]);
      const password =
        (typeof seedOverrides.password === "string" && seedOverrides.password.length > 0
          ? seedOverrides.password
          : null) ?? pick(["password", "pass", "secret"]);
      if (!username || !password) return null;
      return { mode: "basic", username, password };
    }
    case "header": {
      const header_name =
        (typeof seedOverrides.header_name === "string" && seedOverrides.header_name.length > 0
          ? seedOverrides.header_name
          : null) ?? pick(["header_name", "header", "name"]);
      const header_value =
        (typeof seedOverrides.header_value === "string" && seedOverrides.header_value.length > 0
          ? seedOverrides.header_value
          : null) ?? pick(["header_value", "value", "token"]);
      if (!header_name || !header_value) return null;
      return { mode: "header", header_name, header_value };
    }
    case "query": {
      const param =
        (typeof seedOverrides.param === "string" && seedOverrides.param.length > 0
          ? seedOverrides.param
          : null) ?? pick(["param", "name"]);
      const value =
        (typeof seedOverrides.value === "string" && seedOverrides.value.length > 0
          ? seedOverrides.value
          : null) ?? pick(["value", "token"]);
      if (!param || !value) return null;
      return { mode: "query", param, value };
    }
    case "cognito_user_password": {
      // Bootstrap shape for AppSync Cognito + AWS API Gateway Cognito
      // authorizer. The form provides username + password; the engine
      // exchanges them at cognito-idp.<region>.amazonaws.com for an
      // IdToken inside `toDecryptedCredentialAsync`. region +
      // client_id come from the connector config (or seed overrides).
      const username =
        (typeof seedOverrides.username === "string" && seedOverrides.username.length > 0
          ? seedOverrides.username
          : null) ?? pick(["username", "email", "user", "login"]);
      const password =
        (typeof seedOverrides.password === "string" && seedOverrides.password.length > 0
          ? seedOverrides.password
          : null) ?? pick(["password", "pass"]);
      if (!username || !password) return null;
      const out: Extract<AtomicCredentialInput, { mode: "cognito_user_password" }> = {
        mode: "cognito_user_password",
        username,
        password,
      };
      const aws_region =
        (typeof seedOverrides.aws_region === "string" && seedOverrides.aws_region.length > 0
          ? seedOverrides.aws_region
          : null) ?? pick(["aws_region", "region"]);
      if (aws_region) out.aws_region = aws_region;
      const client_id =
        (typeof seedOverrides.client_id === "string" && seedOverrides.client_id.length > 0
          ? seedOverrides.client_id
          : null) ?? pick(["client_id", "cognito_client_id", "app_client_id"]);
      if (client_id) out.client_id = client_id;
      const client_secret =
        (typeof seedOverrides.client_secret === "string" && seedOverrides.client_secret.length > 0
          ? seedOverrides.client_secret
          : null) ?? pick(["client_secret", "cognito_client_secret"]);
      if (client_secret) out.client_secret = client_secret;
      return out;
    }
    case "aws_sigv4": {
      const access_key_id =
        (typeof seedOverrides.access_key_id === "string" && seedOverrides.access_key_id.length > 0
          ? seedOverrides.access_key_id
          : null) ?? pick(["access_key_id", "aws_access_key_id"]);
      const secret_access_key =
        (typeof seedOverrides.secret_access_key === "string" &&
        seedOverrides.secret_access_key.length > 0
          ? seedOverrides.secret_access_key
          : null) ?? pick(["secret_access_key", "aws_secret_access_key", "secret"]);
      if (!access_key_id || !secret_access_key) return null;
      const out: Extract<AtomicCredentialInput, { mode: "aws_sigv4" }> = {
        mode: "aws_sigv4",
        access_key_id,
        secret_access_key,
      };
      const session_token =
        (typeof seedOverrides.session_token === "string" && seedOverrides.session_token.length > 0
          ? seedOverrides.session_token
          : null) ?? pick(["session_token", "aws_session_token"]);
      if (session_token) out.session_token = session_token;
      return out;
    }
    default:
      return null;
  }
}

/**
 * Populate the draft-credential cache from a resolved `ask_user_form`
 * submission, regardless of whether a `commit_intent` fired.
 *
 * The probe-before-save authoring flow needs the credential available
 * to `probe_connector_draft` (which uses a synthetic `draft-<id>`
 * connector_id and so cannot read from `connector_credentials`). We
 * extract the secret from the form output using the live draft's
 * `auth_type` as the seed mode, and cache it in process memory until
 * the connector saves (`saveConnectorAtomic` clears it) or the TTL
 * expires.
 *
 * No-op for non-`ask_user_form` tools, for drafts without an
 * auth-required connector, or when the form output doesn't carry a
 * complete credential. Failures are swallowed — the worst case is a
 * subsequent probe falls back to "credential_required" with a clear
 * message instead of silently bypassing auth.
 */
export async function maybeCacheDraftCredentialFromElicitation(p: {
  tenant_id: string;
  conversation_id: string;
  elicitation: { tool_name: string };
  elicitation_output: unknown;
  db: Db;
}): Promise<void> {
  if (p.elicitation.tool_name !== "ask_user_form") return;
  try {
    const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
    const authType = draft.connector?.auth_type ?? null;
    // Template-enrichment lands `config.oauth` / `config.aws_region`
    // into the draft only at save time (saveConnectorAtomic), so during
    // the credential-cache phase the draft's config block is usually
    // empty for oauth2/aws_sigv4 templates. Fall back to the bound
    // template's metadata. Without this fallback session a2292e7a hit
    // the cache_skipped path with `oauth_grant_type:null` even though
    // the appsync-cognito template declares `grant_type:
    // cognito_user_password` — and the AppSync connector never
    // persisted because the probe ran unauthenticated.
    const draftCfg = (draft.connector?.config ?? {}) as {
      aws_region?: unknown;
      oauth?: { grant_type?: unknown; client_id?: unknown };
    };
    const draftOauthCfg = (draftCfg.oauth ?? {}) as {
      grant_type?: unknown;
      client_id?: unknown;
    };
    const templateSlug = draft.connector?.template_slug ?? null;
    let templateOauth: { grant_type?: unknown; client_id?: unknown } | null = null;
    let templateAwsRegion: unknown = null;
    if (templateSlug && (authType === "oauth2" || authType === "aws_sigv4")) {
      const templates = await listResolvedConnectorTemplates(p.db, p.tenant_id);
      const tmpl = templates.find((t) => t.template.slug === templateSlug)?.template;
      if (tmpl) {
        templateOauth = (tmpl.oauth ?? null) as {
          grant_type?: unknown;
          client_id?: unknown;
        } | null;
        // aws_region lives under the auth_options.aws_sigv4 hint when
        // the template is sigv4-shaped; keep this lookup defensive
        // because not all sigv4 templates declare it.
        const sigv4Opt = (tmpl.auth_options ?? []).find(
          (o: { auth_type?: string }) => o?.auth_type === "aws_sigv4",
        ) as { aws_region?: unknown } | undefined;
        templateAwsRegion = sigv4Opt?.aws_region ?? null;
      }
    }
    // Translate the connector's auth_type into the seed-mode the
    // extractor expects. Pre-fix this gate only let
    // `bearer/basic/header/query` through, silently dropping the
    // form submission for `oauth2 / cognito_user_password` and
    // `aws_sigv4` drafts — that's why the AppSync probe in session
    // f244b896 went out unauthenticated even after the operator
    // submitted the form three times.
    let seedMode: string | null = null;
    if (
      authType === "bearer" ||
      authType === "basic" ||
      authType === "header" ||
      authType === "query"
    ) {
      seedMode = authType;
    } else if (authType === "oauth2") {
      const grantType = draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null;
      if (grantType === "cognito_user_password") seedMode = "cognito_user_password";
      else if (grantType === "password") seedMode = "basic"; // RFC 6749 §4.3 reuses basic shape
    } else if (authType === "aws_sigv4") {
      seedMode = "aws_sigv4";
    }
    if (!seedMode) {
      // Forensic log so future regressions are debuggable from the
      // engine log alone — pre-fix the cache silently early-returned
      // and we had to read source to figure out why.
      logger.info({
        module: "auto-persist",
        action: "draft_credential.cache_skipped",
        msg: "ask_user_form resolved but draft auth_type is unsupported by extractor",
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        auth_type: authType,
        oauth_grant_type:
          authType === "oauth2"
            ? (draftOauthCfg.grant_type ?? templateOauth?.grant_type ?? null)
            : null,
        template_slug: templateSlug,
      });
      return;
    }
    // For oauth2/cognito the connector config carries region + client_id;
    // pass them as seed overrides so the extractor doesn't have to
    // re-parse them out of the form fields when they were already set.
    // Template fallback covers drafts whose config has not yet been
    // template-enriched (the common case at form-submit time).
    const seedOverrides: Record<string, unknown> = {};
    const region = draftCfg.aws_region ?? templateAwsRegion;
    if (typeof region === "string") seedOverrides.aws_region = region;
    const clientId = draftOauthCfg.client_id ?? templateOauth?.client_id;
    if (typeof clientId === "string") seedOverrides.client_id = clientId;
    const credential = extractCredentialFromFormOutput(
      seedMode,
      seedOverrides,
      p.elicitation_output,
    );
    if (!credential) return;
    setDraftCredential(p.conversation_id, credential);
    logger.info({
      module: "auto-persist",
      action: "draft_credential.cached",
      msg: "cached draft credential from ask_user_form",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      mode: credential.mode,
    });
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "draft_credential.cache_failed",
      msg: "failed to cache draft credential — probe will use credential_required path",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Auto-probe a draft connector before the auto-persist save runs.
 *
 * Reads the draft's resolved template; when the template declares a
 * `probe_endpoint` and the draft is in the pre-probe state, dispatches
 * the existing `probe_connector_draft` tool with the template's method
 * + path. The credential cache populated by
 * `maybeCacheDraftCredentialFromElicitation` is what authenticates the
 * probe — so this only fires for the form-submit-then-save bundle.
 *
 * No-op when the connector is missing, has no template_slug, the
 * template has no probe_endpoint, the latest probe already passed, or
 * any failure is encountered (the save will surface
 * `probe_failed`/`connector_not_ready` itself).
 */
/**
 * Refresh the `connector_inspected` and `connector_validated`
 * checkpoints before save. Both are pure draft-side computations that
 * stamp readiness onto the AuthoringState; the LLM is supposed to call
 * them between proposing the connector and asking for save approval,
 * but in practice it routinely skips one or both — we saw this in
 * session 16a8f1c7 where the model went probe → ask_user_confirm and
 * the auto-persist path bounced off `connector_not_ready` because
 * `connector_validated` was still missing. The user then had to
 * approve a SECOND time after the model retried through the
 * tool-policy gate.
 *
 * The harness already auto-probes here; auto-inspect+auto-validate is
 * the same idea: the operator's "yes save" click is the authority,
 * and the engine should make sure it can act on it instead of
 * deferring to LLM-discipline checkpoints.
 *
 * No-op when there is no connector draft. Failures fall through; the
 * subsequent `saveConnectorAtomic` will surface the canonical
 * structured error.
 */
async function maybeAutoFreshenCheckpointsForSave(ctx: ToolContext): Promise<void> {
  try {
    const draft = ctx.getDraft();
    if (!draft.connector) return;
    await inspectConnectorDraftTool.execute(ctx, {});
    await validateConnectorDraftTool.execute(ctx, {});
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "auto_freshen_checkpoints_failed",
      msg: "auto-inspect/validate before save failed — falling through to saveConnectorAtomic which will surface the gate error",
      conversation_id: ctx.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function maybeAutoProbeForSave(ctx: ToolContext, tenant_id: string): Promise<void> {
  try {
    const draft = ctx.getDraft();
    const connector = draft.connector;
    if (!connector) return;
    const requiresProbe =
      connector.driver === "http" ||
      connector.driver === "graphql" ||
      connector.driver === "postgres" ||
      connector.driver === "s3";
    if (!requiresProbe) return;
    if (connector.latest_probe?.ok === true) return;
    if (!connector.template_slug) return;
    const templates = await listResolvedConnectorTemplates(ctx.db, tenant_id);
    const template = templates.find((t) => t.template.slug === connector.template_slug)?.template;
    const probeEndpoint = template?.probe_endpoint;
    if (!probeEndpoint) return;
    await probeConnectorDraftTool.execute(ctx, {
      method: probeEndpoint.method,
      path: probeEndpoint.path === "" ? "/" : probeEndpoint.path,
    });
  } catch (err) {
    logger.warn({
      module: "auto-persist",
      action: "auto_probe_failed",
      msg: "auto-probe before save failed — falling through to saveConnectorAtomic which will surface probe_failed",
      tenant_id,
      conversation_id: ctx.conversation_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchDeleteConnector(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const id = readString(intent.payload, "id");
  if (!id) {
    return {
      ok: false,
      error_code: "invalid_payload",
      message: "delete_connector commit_intent requires payload.id",
      next_best_actions: ["ask_user"],
    };
  }
  const ok = await ctx.engineClient.connectors.delete(id);
  if (!ok) {
    return {
      ok: false,
      error_code: "connector_not_found",
      message: `connector ${id} does not exist or was already deleted`,
      next_best_actions: ["cannot_help"],
    };
  }
  await ctx.db
    .update(conversations)
    .set({ target_connector_id: null, updated_at: new Date() })
    .where(eq(conversations.id, ctx.conversation_id));
  return {
    ok: true,
    data: { id, deleted: true, kind: "connector" },
  };
}

async function dispatchDeleteWorkflow(ctx: ToolContext, intent: CommitIntent): Promise<ToolResult> {
  const id = readString(intent.payload, "id");
  if (!id) {
    return {
      ok: false,
      error_code: "invalid_payload",
      message: "delete_workflow commit_intent requires payload.id",
      next_best_actions: ["ask_user"],
    };
  }
  const ok = await ctx.engineClient.workflows.delete(id);
  if (!ok) {
    return {
      ok: false,
      error_code: "workflow_not_found",
      message: `workflow ${id} does not exist or was already deleted`,
      next_best_actions: ["cannot_help"],
    };
  }
  await ctx.db
    .update(conversations)
    .set({ target_workflow_id: null, updated_at: new Date() })
    .where(eq(conversations.id, ctx.conversation_id));
  return {
    ok: true,
    data: { id, deleted: true, kind: "workflow" },
  };
}

async function dispatchRollbackSkipped(
  ctx: ToolContext,
  intent: CommitIntent,
): Promise<ToolResult> {
  const execution_id = readString(intent.payload, "execution_id");
  // Audit the skipped rollback so operators can see the no-op trail.
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      actor_type: ctx.actor_id ? "user" : "system",
      actor_id: ctx.actor_id,
      action: AuditAction.EXECUTION_ABORTED,
      resource_type: "execution",
      resource_id: execution_id ?? null,
      result: "denied",
      reason: "not_implemented",
      metadata: {
        source: "harness_auto_persist",
        commit_intent_kind: "rollback_after_execute",
        skipped: true,
      },
    },
    ctx.db,
  );
  return {
    ok: false,
    error_code: "not_implemented",
    message:
      "rollback_after_execute is not implemented yet — the harness recorded an audit_log.rollback.skipped row with reason=not_implemented",
    next_best_actions: ["cannot_help"],
    data: {
      kind: "rollback_after_execute",
      skipped: true,
      reason: "not_implemented",
      ...(execution_id ? { execution_id } : {}),
    },
  };
}

/**
 * Insert a synthetic `conversation_tool_calls` row + matching `tool`
 * message into the conversation timeline. The row carries `output =
 * synthetic` so `buildModelMessages` emits a `tool-call` +
 * `tool-result` pair on the next turn — the LLM sees it as a normal
 * tool result with `source: "harness_auto_persist"`.
 */
async function injectSyntheticToolCall(p: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  synthetic: SyntheticToolResult;
  intent: CommitIntent;
}): Promise<string> {
  const callId = await insertToolCall(p.db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    tool: p.synthetic.tool,
    input: {
      _harness_auto_persist: true,
      commit_intent_kind: p.intent.kind,
      description: p.intent.description,
    },
    approval_required: false,
  });
  await updateToolCallOutput(p.db, callId, p.synthetic);
  // Confirmation-state column carries `confirmed` so the read path
  // and observability dashboards can filter on harness-driven writes.
  await p.db
    .update(conversationToolCalls)
    .set({
      confirmation_state: p.synthetic.ok ? "confirmed" : "declined",
      confirmation_data: { source: "harness_auto_persist", commit_intent_kind: p.intent.kind },
    })
    .where(eq(conversationToolCalls.id, callId));
  await appendMessage(p.db, p.tenant_id, p.conversation_id, "tool", {
    tool: p.synthetic.tool,
    output: p.synthetic,
    _harness_auto_persist: true,
  });
  return callId;
}
