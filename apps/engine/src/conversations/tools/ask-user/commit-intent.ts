import { z } from "@hono/zod-openapi";

const MODEL_COMMIT_INTENT_KINDS = [
  "save_connector_draft",
  "save_workflow_draft",
  "delete_connector",
  "delete_workflow",
  "rollback_after_execute",
  "oauth_completed",
  "credential_reissue_completed",
  "run_workflow",
  "create_api_key",
  "apply_workflow_patch",
  "update_workflow_metadata",
] as const;

const ENGINE_COMMIT_INTENT_KINDS = [
  "commit_held_workflow_writes",
  "execute_confirmed_tool_call",
  "grant_relayed_tool_call",
  "confirm_local_command",
] as const;

export const COMMIT_INTENT_KINDS = [
  ...MODEL_COMMIT_INTENT_KINDS,
  ...ENGINE_COMMIT_INTENT_KINDS,
] as const;

export type CommitIntentKind = (typeof COMMIT_INTENT_KINDS)[number];

export const APPROVAL_HANDLE_KEY = "approval_id";

export function approvalHandleFromElicitationInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const intent = (input as { commit_intent?: unknown }).commit_intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  const payload = (intent as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const handle = (payload as Record<string, unknown>)[APPROVAL_HANDLE_KEY];
  return typeof handle === "string" && handle.length > 0 ? handle : null;
}

export function isWorkflowInputForm(toolName: string, input: unknown): boolean {
  if (toolName !== "ask_user_form" || approvalHandleFromElicitationInput(input)) return false;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const intent = (input as { commit_intent?: unknown }).commit_intent;
  return (
    !!intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    (intent as { kind?: unknown }).kind === "run_workflow"
  );
}

export function withApprovalHandle(
  intent: Record<string, unknown>,
  approvalId: string,
): Record<string, unknown> {
  const payload =
    intent.payload && typeof intent.payload === "object" && !Array.isArray(intent.payload)
      ? (intent.payload as Record<string, unknown>)
      : {};
  return { ...intent, payload: { ...payload, [APPROVAL_HANDLE_KEY]: approvalId } };
}

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

export function elicitationInputForClient(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return withoutApprovalHandle(input as Record<string, unknown>);
}

export const commitIntentSchema = z
  .object({
    kind: z.enum(MODEL_COMMIT_INTENT_KINDS),
    payload: z.record(z.string(), z.unknown()),
    description: z.string().min(1),
  })
  .describe(
    "Optional commit intent carrier. When set, the harness applies the intended write atomically when the operator submits this elicitation. The LLM does NOT need to call the underlying tool afterwards — the synthetic tool result the harness injects has source=harness_auto_persist.",
  );

export type ModelCommitIntent = z.infer<typeof commitIntentSchema>;

export interface CommitIntent {
  kind: CommitIntentKind;
  payload: Record<string, unknown>;
  description: string;
}

interface PatchOpEntry {
  label: string;
  preview?: string;
}

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
