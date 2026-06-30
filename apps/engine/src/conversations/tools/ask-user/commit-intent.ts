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
// This file owns the schema + types so both ask-user tools and the
// resume-side dispatcher import the same shape.

import { z } from "@hono/zod-openapi";

export const COMMIT_INTENT_KINDS = [
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
  // Metadata-only workflow edit (rename / re-describe / archive). Routes the
  // confirm approval straight to the `update_workflow` tool so a description or
  // name change auto-persists without the model issuing a second tool call —
  // and without the heavyweight dry_run/save_workflow_draft cycle a text-only
  // edit never needed. The preview-free path that fixes the authoring drift
  // where editing a description felt like it required running the workflow.
  "update_workflow_metadata",
] as const;

export type CommitIntentKind = (typeof COMMIT_INTENT_KINDS)[number];

export const commitIntentSchema = z
  .object({
    kind: z.enum(COMMIT_INTENT_KINDS),
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

export type CommitIntent = z.infer<typeof commitIntentSchema>;
