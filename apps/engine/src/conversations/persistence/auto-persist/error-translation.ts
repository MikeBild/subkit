import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";

export type ErrorTranslationContext = CommitIntent["kind"] | "update_connector" | "update_workflow";

export function translateAutoPersistError(
  err: unknown,
  intentKind: ErrorTranslationContext,
): { error_code: string; message: string; next_best_actions: string[] } {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const detail =
    typeof (err as { detail?: unknown })?.detail === "string"
      ? ((err as { detail: string }).detail as string)
      : null;
  const lower = msg.toLowerCase();
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
  if (code === "23503" || /foreign key|violates foreign key/i.test(lower)) {
    return {
      error_code: "in_use_by_dependent_rows",
      message: `Cannot complete the operation because the resource is still referenced by another row. Detail: ${detail ?? msg}`,
      next_best_actions: ["list_executions", "list_workflows", "list_connectors", "ask_user_text"],
    };
  }
  if (code === "23502" || /null value|violates not-null/i.test(lower)) {
    return {
      error_code: "missing_required_field",
      message: `A required field is missing on the draft. Detail: ${detail ?? msg}`,
      next_best_actions: ["inspect_connector_draft", "inspect_workflow_draft", "validate_draft"],
    };
  }
  if (code === "22P02" || /invalid input syntax/i.test(lower)) {
    return {
      error_code: "invalid_input_format",
      message: `An input value has the wrong format (likely a malformed uuid or enum). Detail: ${detail ?? msg}`,
      next_best_actions: ["inspect_authoring_context", "inspect_connector_draft"],
    };
  }
  return {
    error_code: "auto_persist_failed",
    message: `Unexpected error while persisting the ${intentKind} write. ${msg}. Surface this as a clear question for the user: report what failed and ask whether to retry, change inputs, or escalate.`,
    next_best_actions: ["ask_user_text", "cannot_help"],
  };
}
