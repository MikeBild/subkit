// Harness-side auto-persist dispatcher (PR11/PR12).
//
// When an `ask_user_form` or `ask_user_confirm` carries a
// `commit_intent`, the harness applies the proposed write atomically
// once the operator submits. The LLM does NOT need to call the
// underlying tool (save_connector_draft / commit_draft / delete_*)
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
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { logger } from "../../logging/logger.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { appendMessage, insertToolCall, updateToolCallOutput } from "../persist.ts";
import { COMMIT_INTENT_KINDS, type CommitIntent } from "../tools/ask-user/commit-intent.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
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
  if (!intent) return { dispatched: false };

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
      case "commit_workflow_draft": {
        toolName = "commit_draft";
        const targetId = readString(intent.payload, "target_workflow_id");
        result = await commitWorkflowAtomic({
          ctx,
          ...(targetId ? { target_workflow_id: targetId } : {}),
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
    logger.error({
      module: "auto-persist",
      action: "dispatch.threw",
      msg: "auto-persist dispatcher threw — surfacing structured error to the LLM",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      commit_intent_kind: intent.kind,
      error: msg,
    });
    const synthetic: SyntheticToolResult = {
      tool: intentToolName(intent.kind),
      ok: false,
      error_code: "auto_persist_failed",
      message: msg,
      next_best_actions: ["ask_user", "cannot_help"],
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

function intentToolName(kind: CommitIntent["kind"]): string {
  switch (kind) {
    case "save_connector_draft":
      return "save_connector_draft";
    case "commit_workflow_draft":
      return "commit_draft";
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
    if (
      authType !== "bearer" &&
      authType !== "basic" &&
      authType !== "header" &&
      authType !== "query"
    ) {
      return;
    }
    const credential = extractCredentialFromFormOutput(authType, {}, p.elicitation_output);
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
