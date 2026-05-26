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
     * For `delete_connector` / `delete_workflow` — `{ id, hard?: boolean }`.
     *
     * For `save_workflow_draft` — `{ target_workflow_id?: string }`.
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
