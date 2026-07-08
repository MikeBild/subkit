// Optional `commit_intent` carrier on `ask_user_form` / `ask_user_confirm`.
//
// When the LLM proposes a write that the operator must approve, it can
// attach a `commit_intent` describing the intended write. The harness
// (see `conversations/elicitations.ts#resumeElicitationAndDispatch`)
// then applies the write atomically when the operator submits — the
// LLM's next turn sees a synthetic tool result describing the
// persistence and does NOT need to call save_connector_draft /
// save_workflow_draft itself.
//
// TWO DISJOINT SETS OF KINDS, AND THE MODEL CAN ONLY NAME ONE OF THEM.
// `MODEL_COMMIT_INTENT_KINDS` is what the published `ask_user_*` schema
// accepts. `ENGINE_COMMIT_INTENT_KINDS` are the carriers the engine attaches
// to the elicitations IT raises; each names a single-use approval handle whose
// claim performs a write. A model that could name one of those in its own
// `ask_user_confirm` would be choosing the execution target for a capability
// the operator granted to a DIFFERENT call — a confused deputy. The Zod enum
// below, not a comment, is what makes that unreachable.
//
// This file owns the schema + types so both ask-user tools and the
// resume-side dispatcher import the same shape.

import { z } from "@hono/zod-openapi";

/** Kinds the LLM may attach to its own `ask_user_form` / `ask_user_confirm`. */
export const MODEL_COMMIT_INTENT_KINDS = [
  "save_connector_draft",
  "save_workflow_draft",
  "delete_connector",
  "delete_workflow",
  "rollback_after_execute",
  // G8 (runtime-logs review plan): OAuth elicitations now carry a
  // commit_intent so when the operator resolves the
  // "Have you completed the authorization in your browser?" confirm,
  // the dispatcher injects a synthetic tool result naming the saved
  // credential. Pre-fix the LLM had to scan chat history to figure
  // out the OAuth flow had completed and which tool to retry; the
  // engine logged `auto_persist.skipped: elicitation resolved without
  // commit_intent` on every OAuth approval (session ed20f48d).
  "oauth_completed",
  // run_workflow's missing-input auto-form carries this intent so the
  // harness executes the run with the submitted values directly on
  // form submit. Pre-fix the resume contract relied on the LLM
  // re-issuing run_workflow with the answers — observed live (6.14.1,
  // get-jira-ticket-details): the model re-called with empty input and
  // looped back into the same form.
  "run_workflow",
  "create_api_key",
  // Partial-accept of a workflow-draft edit (D3). Carries the full RFC-6902
  // patch array (`payload.patches`) proposed by `edit_workflow_patch`. When
  // the operator resolves the `partial_diff_approval` confirm, the harness
  // reads `output.approved_indices` and applies ONLY the accepted subset of
  // ops to the draft — accept-all, decline-all, or partial — then re-previews
  // and reports exactly which ops landed vs were skipped. The draft is NOT
  // mutated until approval, so a decline is a true no-op (nothing to roll
  // back). Surface-agnostic: sk-cli local, portal, and MCP all funnel the
  // selection through this one commit_intent.
  "apply_workflow_patch",
  // Metadata-only workflow edit (rename / re-describe / archive). Routes the
  // confirm approval straight to the `update_workflow` tool so a description or
  // name change auto-persists without the model issuing a second tool call —
  // and without the heavyweight dry_run/save_workflow_draft cycle a text-only
  // edit never needed. The preview-free path that fixes the authoring drift
  // where editing a description felt like it required running the workflow.
  "update_workflow_metadata",
] as const;

/**
 * Kinds ONLY the engine may author. Each carries an `approval_id` — a
 * single-use capability handle over args the engine encrypted — so claiming it
 * performs a write. They are absent from `commitIntentSchema`, which is what
 * `ask_user_form` / `ask_user_confirm` publish, so no model-emitted tool call
 * can name one. The harness accepts them only off an elicitation row the engine
 * wrote itself.
 */
export const ENGINE_COMMIT_INTENT_KINDS = [
  // A `wf_<slug>` chat run whose write steps were held in preview. The engine —
  // not the model — releases them: the harness claims the single-use approval
  // named in `payload.approval_id` and replays the inputs it encrypted at
  // preview time. The approval's own `tool` names the workflow that runs.
  "commit_held_workflow_writes",
  // The universal carrier for a policy-gated chat tool call that has no
  // shape-specific kind above. `sdk-wrap/invoke.ts` mints a single-use approval
  // over the exact args the gate paused on and names it here; when the operator
  // answers, the HARNESS claims it and runs the tool. The model never sees the
  // approval id, its published schema carries no confirm marker, and there is
  // no argument on any wrapped tool that clears the gate. A model-settable
  // approval marker is an escape hatch, not a gate.
  "execute_confirmed_tool_call",
  // GRANT-ONLY carrier for a policy-gated EXTERNAL MCP tool call
  // (`sdk-wrap/external-mcp-tools.ts`). Unlike `execute_confirmed_tool_call`,
  // the harness CANNOT perform this call: a remote MCP invocation must be
  // re-issued by the MODEL and run in-engine (`executeExternalMcpTool` →
  // `pool.invokeRemoteTool`), which a harness resume does not do. So the
  // operator's answer GRANTS the approval (`grantApprovalIfHuman`) and stops —
  // the model's separate re-issue then claims the now-granted row
  // (`consumeApproval`, which demands `granted_at`) and performs the call. The
  // model never sees the approval id; a re-issue against an ungranted row goes
  // nowhere.
  "grant_relayed_tool_call",
] as const;

/** Everything the harness dispatcher can be handed, from either author. */
export const COMMIT_INTENT_KINDS = [
  ...MODEL_COMMIT_INTENT_KINDS,
  ...ENGINE_COMMIT_INTENT_KINDS,
] as const;

export type CommitIntentKind = (typeof COMMIT_INTENT_KINDS)[number];

/**
 * The payload key carrying the single-use approval handle on an engine-authored
 * commit_intent.
 *
 * The handle is not a capability. `consumeApproval` claims only a row a HUMAN
 * granted, nothing a model can call grants one, and no chat tool publishes an
 * argument that names one. It is the internal coordinate of a governance
 * decision that is still PENDING, so it stays on the elicitation row the harness
 * reads and does not travel with the PROMPT.
 *
 * Precisely: no rendering of a pending `ask_user_*` prompt carries it.
 * `elicitationInputForClient` is the one projection, applied at each layer that
 * owns an outbound shape — the `elicit_request` / pause envelopes
 * (`sdk-wrap/invoke.ts`, `sdk-wrap/synthetic-workflow-tools.ts`), the SSE replay
 * (`http/routes/conversations/stream.ts`), the MCP poll
 * (`mcp/capabilities/conversations.ts`), and the two errors that serialize a
 * pending prompt into an HTTP body (`PendingElicitationBlockedError`,
 * `ElicitationValidationError`, both sanitizing in their constructors).
 *
 * What DOES name it: the terminal prose of a claim (`consumeApproval`'s denial
 * messages) and the `approval_url` an operator opens. Both describe a decision
 * that has already been triggered, and neither confers anything — same reason
 * MCP hands `confirm_id` back to the model as a trigger.
 */
export const APPROVAL_HANDLE_KEY = "approval_id";

/**
 * The single-use approval handle a persisted elicitation row carries, or `null`
 * when it carries none.
 *
 * Read straight off `input.commit_intent.payload`, deliberately WITHOUT
 * validating `kind` against `COMMIT_INTENT_KINDS`: the question is not "did the
 * engine author this intent" but "does resolving this elicitation claim an
 * approval". Any row that names a handle does, whatever its kind reads as.
 *
 * The answer decides whether an elicitation is model-resolvable. A form, choice,
 * text, or multi answer is DATA the model may relay. An elicitation carrying an
 * approval handle IS a person's pending decision: resolving it consumes their
 * one chance to make it, and answering "no" on their behalf kills the approval
 * for good. No model-callable path may resolve one
 * (`mcp/capabilities/conversations.ts`).
 */
export function approvalHandleFromElicitationInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const intent = (input as { commit_intent?: unknown }).commit_intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  const payload = (intent as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const handle = (payload as Record<string, unknown>)[APPROVAL_HANDLE_KEY];
  return typeof handle === "string" && handle.length > 0 ? handle : null;
}

/**
 * The elicitation input with the approval handle removed — the projection the
 * model's tool-result, the SDK pause envelope, and every client-facing
 * `elicit_request` frame carry. Everything an operator's client renders
 * (`description`, `target`, `pending_output`) survives; only the capability
 * does not. Returns the input unchanged when it carries no handle.
 */
export function withoutApprovalHandle(input: Record<string, unknown>): Record<string, unknown> {
  const intent = input.commit_intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return input;
  const { payload, ...intentRest } = intent as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return input;
  const payloadRecord = payload as Record<string, unknown>;
  if (!(APPROVAL_HANDLE_KEY in payloadRecord)) return input;
  const { [APPROVAL_HANDLE_KEY]: _handle, ...safePayload } = payloadRecord;
  return { ...input, commit_intent: { ...intentRest, payload: safePayload } };
}

/**
 * `withoutApprovalHandle` widened to the `unknown` an elicitation row's `input`
 * column actually has. Every outbound path that carries a persisted elicitation
 * prompt — SSE replay, MCP poll, the two pending-prompt errors — projects
 * through this. Non-object inputs pass through unchanged.
 */
export function elicitationInputForClient(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return withoutApprovalHandle(input as Record<string, unknown>);
}

export const commitIntentSchema = z
  .object({
    kind: z.enum(MODEL_COMMIT_INTENT_KINDS),
    /**
     * Tool-specific arguments the harness merges with the operator's
     * form values before dispatching the internal write.
     *
     * For `save_connector_draft` — `{ environment: "dev"|"prod" }` plus
     * any structural credential fields the form value cannot supply.
     * The harness merges form values into `payload.credential` (e.g.
     * `{ token }` from a single-field bearer form becomes
     * `payload.credential = { mode: "bearer", token }`).
     *
     * Credential-collecting forms MUST use the canonical field names
     * (see `persistence/credential-form-contract.ts` — enforced at form
     * creation via `credential_form_mismatch`):
     *   bearer                → token
     *   basic                 → username, password
     *   header                → header_name, header_value
     *   query                 → param, value
     *   aws_sigv4             → access_key_id, secret_access_key
     *                           (+ optional session_token)
     *   cognito_user_password → username, password (+ optional
     *                           aws_region, client_id, client_secret)
     *   oauth2                → client_id (+ optional client_secret,
     *                           token_endpoint, authorization_endpoint,
     *                           scopes)
     * Labels stay free-form; field NAMES are the contract. A slot the
     * LLM already supplies in `payload.credential` (e.g. header_name)
     * does not need a form field. For basic auth collect username +
     * password as separate fields — never ask the user to compose or
     * base64-encode "user:pass"; the driver does the encoding.
     *
     * For `delete_connector` / `delete_workflow` — `{ id, hard?: boolean }`.
     *
     * For `save_workflow_draft` — `{ target_workflow_id?: string }`.
     *
     * For `run_workflow` — `{ workflow_id, workflow_slug?, environment?,
     * input_partial? }`. The harness merges the submitted form values
     * over `input_partial` and runs the execution directly.
     *
     * For `create_api_key` — the create_api_key tool input shape.
     * The harness mints the key directly after approval so the model
     * cannot forget to re-issue the write and leave the operator with
     * an approved no-op.
     *
     * For `update_workflow_metadata` — the `update_workflow` tool input
     * shape: `{ id (uuid), slug?, name?, description?, lifecycle? }`. The
     * harness applies the metadata patch directly after approval (no draft,
     * no dry_run, no version rotation). Resolve the workflow `id` first via
     * find_workflow / get_workflow.
     *
     * For `rollback_after_execute` — `{ execution_id }` (NOT
     * implemented yet; harness emits a no-op result).
     *
     * The engine-authored `ENGINE_COMMIT_INTENT_KINDS` carry
     * `{ tool, approval_id }` and nothing else. `tool` is the CAS predicate the
     * claim is checked against, `approval_id` the handle; the target and the
     * args both come off the claimed approval (or, for
     * `grant_relayed_tool_call`, off the model's own re-issue). There is
     * deliberately no field for the model to fill, and no way for it to reach
     * this branch of the enum.
     */
    payload: z.record(z.string(), z.unknown()),
    /**
     * Human-readable summary shown in the confirmation UI. The CLI
     * renders it next to the form/confirm prompt so the operator
     * understands what will happen if they submit.
     */
    description: z.string().min(1),
  })
  .describe(
    "Optional commit intent carrier. When set, the harness applies the intended write atomically when the operator submits this elicitation. The LLM does NOT need to call the underlying tool afterwards — the synthetic tool result the harness injects has source=harness_auto_persist.",
  );

/** A model-authored commit_intent, exactly as the published schema accepts it. */
export type ModelCommitIntent = z.infer<typeof commitIntentSchema>;

/** What the harness dispatcher receives: either author's kind. Widened past the
 *  model-facing schema on purpose — `extractCommitIntent` reads it off the
 *  persisted elicitation row, whose engine-authored kinds Zod never sees. */
export interface CommitIntent {
  kind: CommitIntentKind;
  payload: Record<string, unknown>;
  description: string;
}

/**
 * One per-op review row shown by the `partial_diff_approval` confirm card
 * (`PartialApprovalPrompt`). `label` is the human-readable op summary
 * (`replace /steps/0/id`); `preview` is the compact value it sets, when the
 * op carries one. Derived from the `apply_workflow_patch` commit_intent's
 * `payload.patches` so the model never has to duplicate the diff list.
 */
export interface PatchOpEntry {
  label: string;
  preview?: string;
}

/**
 * Describe an RFC-6902 patch array as per-op review rows for the
 * partial-accept confirm card AND the applied/skipped report the harness
 * injects after dispatch. Tolerant of loosely-typed ops (reads from the
 * open commit_intent payload). Pure + deterministic.
 */
export function describePatchOps(patches: ReadonlyArray<unknown>): PatchOpEntry[] {
  return patches.map((raw) => {
    const op = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const opName = typeof op.op === "string" ? op.op : "?";
    const path = typeof op.path === "string" ? op.path : "?";
    const from = typeof op.from === "string" ? op.from : null;
    const label = from ? `${opName} ${path} ← ${from}` : `${opName} ${path}`;
    if ("value" in op) {
      const v = op.value;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (typeof s === "string") {
        const preview = s.length > 120 ? `${s.slice(0, 119)}…` : s;
        return { label, preview };
      }
    }
    return { label };
  });
}
