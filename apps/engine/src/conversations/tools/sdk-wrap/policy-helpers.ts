// Confirmation / elicitation / dedupe helpers used by the wrapper.
// Pure functions only — no side effects, no DB access. They translate
// tool names + raw args + assistant text into commit-intent shapes,
// risk metadata, and prose-confirmation matches.

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
  const workflowId = typeof obj.workflow_id === "string" ? obj.workflow_id : null;
  const connectorId = typeof obj.connector_id === "string" ? obj.connector_id : null;
  const environment = typeof obj.environment === "string" ? obj.environment : null;
  const target = slug ?? workflowId ?? connectorId ?? null;
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
 * Map tenant_write tools to the `commit_intent.kind` value the LLM
 * uses when it surfaces an `ask_user_confirm` for that intent. When a
 * recently-resolved elicitation matches this kind, the policy-gate
 * skips its own confirmation so the operator only sees one prompt
 * per intent (instead of "yes / approve / yes / approve").
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
    default:
      return null;
  }
}

/**
 * Pull plain text out of a persisted conversation_messages.content
 * payload. Messages are jsonb; content is usually either a string or
 * an array of `{ type, text }` parts (Anthropic shape) or a single
 * `{ text }` object. Extracts every string we can find and joins.
 * Returns `""` when nothing usable is present.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (Array.isArray(content)) {
    return content
      .map((p) => extractText(p))
      .filter((s) => s.length > 0)
      .join(" ");
  }
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.parts)) return extractText(obj.parts);
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return "";
}

/**
 * Detect whether the user's free-text reply is an unambiguous
 * affirmation. Conservative — only the short canonical forms count
 * so a chatty "yes please go ahead but skip the broken one" does
 * NOT bypass the gate (the user's intent there is more nuanced).
 * Mirrors the regex in apps/sk/src/elicitation-intent.ts so the CLI
 * + engine agree on what "yes" means.
 */
const PROSE_AFFIRMATION_RE =
  /^(?:yes(?: please)?|y|yep|yeah|yup|sure|of course|absolutely|ok(?:ay)?|fine|approve(?:d)?|confirm(?:ed)?|go(?: ahead)?|do it|proceed|please proceed|please do|go for it|let's do it|ship it)\.?$/i;

export function isAffirmation(text: string): boolean {
  return PROSE_AFFIRMATION_RE.test(text.trim().replace(/[.!?\s]+$/, ""));
}

/**
 * Detect whether the assistant's prior message was a prose pre-
 * confirmation about the SAME destructive intent the policy gate is
 * about to fire on. Two signals must both match:
 *   1. A pre-confirmation phrase ("shall I proceed", "do you want me
 *      to delete", "confirm if I should", "should I go ahead", etc.).
 *   2. A reference to the operation's verb / object (delete /
 *      revoke / drop + a noun matching the tool's resource type).
 * Conservative on purpose — false positives let through unconfirmed
 * destructive writes, so any miss falls through to the policy gate.
 */
const PROSE_PRECONFIRM_RE =
  /\b(shall i (?:proceed|continue|delete|remove|drop|revoke)|should i (?:proceed|continue|go ahead|delete|remove)|do you want me to (?:proceed|continue|delete|remove|drop|revoke)|confirm (?:if|that|whether)|(?:proceed|go ahead) (?:to|with) (?:delete|remove|drop|revoke))\b/i;

export function referencesProseConfirmation(asstText: string, toolName: string): boolean {
  // Map the tool to a noun the prose is likely to mention. Without
  // this match the dedupe could trigger on an unrelated prior
  // question — too risky for a destructive write.
  const verbObject = (() => {
    if (toolName === "delete_workflow") return /\bworkflow/i;
    if (toolName === "delete_connector") return /\bconnector/i;
    if (toolName === "delete_knowledge_source") return /\bknowledge/i;
    if (toolName === "delete_subscription") return /\bsubscription/i;
    if (toolName === "delete_tunnel") return /\btunnel/i;
    if (toolName === "delete_schedule") return /\bschedule/i;
    if (toolName === "revoke_api_key") return /\b(?:api[_ ]?key|key)/i;
    if (toolName === "revoke_portal_token") return /\b(?:portal[_ ]?token|token)/i;
    return null;
  })();
  if (!verbObject) return false;
  // Both signals must co-occur in the SAME sentence. Pre-fix the
  // checker globbed the whole assistant message and false-matched on
  // "Your DigitalOcean connector is configured. Shall I proceed to
  // fetch your projects?" → `connector` and `Shall I proceed`
  // appeared in different sentences but the OR-in-message check
  // skipped the gate as if they were one intent. Splitting on
  // sentence-ending punctuation (`.!?`) tightens the heuristic so the
  // dedupe only fires when the prose is actually asking about THIS
  // resource type.
  const sentences = asstText.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (PROSE_PRECONFIRM_RE.test(sentence) && verbObject.test(sentence)) {
      return true;
    }
  }
  return false;
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
  // run_workflow / update_* — payload shapes still owned by the
  // LLM-driven ask_user_confirm path; the policy-gate fallback for
  // these uses the re-issue contract.
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
