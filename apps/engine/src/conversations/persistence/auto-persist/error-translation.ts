// Map a thrown Postgres / runtime error to a structured envelope the
// LLM can act on. Without this every dispatch failure surfaced as the
// vague "database error" prose (session abeefb33) and the LLM fell
// back to `cannot_help`, leaving the user staring at a colon with no
// recovery path. The mapping uses Postgres SQLSTATE codes when
// available (`pg` exposes them via `err.code`) plus regex fallbacks
// on the message.

import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";

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
  // pg errors carry .code (SQLSTATE) — untyped on the thrown value.
  const code = (err as { code?: unknown } | null | undefined)?.code;
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
