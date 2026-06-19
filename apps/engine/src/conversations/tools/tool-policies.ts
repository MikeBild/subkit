// Tool execution-mode resolver — the ONE place that decides whether a
// tool call must pause for human confirmation.
//
// Maps `(toolName, input shape, runtime ctx) → ExecutionMode`. Sensitive
// input shapes (PATs, JWTs, anything matched by SECRET_PATTERNS),
// destructive tools, external calls, and prod-environment writes all
// upgrade to `confirm_before_execution`.
//
// Invariants:
//   - Pure / deterministic. Predicates take the raw input and return an
//     ExecutionMode; no I/O, no time-dependence.
//   - Unknown tools default to `auto` — the resolver is permissive so
//     a missing policy entry never accidentally blocks a tool. Adding
//     a new dangerous tool requires an explicit row here.
//   - Runtime ctx (`tenant_id`, `environment`) is read-only context the
//     predicates may consult; the resolver never mutates it.
//
// This module is the source of truth for the dangerous-tools confirm
// gate. The legacy `dangerous-tools.ts` set is folded into TOOL_POLICIES
// below — palettes only decide visibility, this resolver decides
// execution mode.

import { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from "../../logging/scrub-secrets.ts";

export type ExecutionMode = "auto" | "confirm_before_execution" | "confirm_after_execution";

/** Runtime ctx threaded into every dynamic predicate. */
export interface ToolPolicyContext {
  tenant_id: string;
  /** Target deployment environment for the call (`dev` / `stage` / `prod` / …). */
  environment?: string;
}

/** Categorises why a confirmation is being demanded — drives client UX. */
export type ConfirmationKind =
  | "destructive"
  | "sensitive_input"
  | "external_call"
  | "schema_change";

export interface ToolPolicy {
  name: string;
  defaultMode: ExecutionMode;
  computeModeFromInput?: (input: unknown, ctx: ToolPolicyContext) => ExecutionMode;
  confirmationKind?: ConfirmationKind;
  /** Human-readable rationale shown in the confirmation UI. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const SENSITIVE_DEPTH_LIMIT = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringMatchesSecretShape(value: string): boolean {
  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(value)) {
      regex.lastIndex = 0;
      return true;
    }
  }
  return false;
}

function walkForSensitive(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (depth >= SENSITIVE_DEPTH_LIMIT) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return stringMatchesSecretShape(value);
  if (typeof value !== "object") return false;
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkForSensitive(item, depth + 1, seen)) return true;
    }
    return false;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof child === "string" && child.trim().length > 0) {
      return true;
    }
    if (walkForSensitive(child, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * `confirm_before_execution` if any string in `input` matches a known
 * secret shape (PATs, JWTs, AWS keys, Bearer tokens, …) OR any object
 * key matches `SENSITIVE_KEY_PATTERN` and carries a non-empty string
 * value. Otherwise `auto`.
 *
 * Reuses the same `SECRET_PATTERNS` / `SENSITIVE_KEY_PATTERN` the log
 * scrubber uses, so "what counts as a secret" stays in lockstep with
 * "what gets redacted in audit rows".
 */
export function confirmIfSensitiveInput(input: unknown): ExecutionMode {
  return walkForSensitive(input, 0, new WeakSet<object>()) ? "confirm_before_execution" : "auto";
}

const AUTH_TOUCHING_KEYS: ReadonlyArray<string> = ["auth_type", "credential", "base_url", "dsn"];

/**
 * `confirm_before_execution` when the patch touches any auth-shaped
 * field — switching auth_type, swapping credentials, repointing base_url
 * or dsn rotates the trust boundary. Otherwise `auto`.
 */
export function confirmIfTouchesAuth(input: unknown): ExecutionMode {
  if (!isPlainObject(input)) return "auto";
  for (const key of AUTH_TOUCHING_KEYS) {
    if (key in input && input[key] !== undefined && input[key] !== null) {
      return "confirm_before_execution";
    }
  }
  return "auto";
}

/**
 * `confirm_before_execution` when the call is targeting a non-`dev`
 * environment. `input.environment` wins over `ctx.environment`; both
 * unset means we treat the call as `dev` and stay in `auto`.
 */
export function confirmIfNonDevEnv(input: unknown, ctx: ToolPolicyContext): ExecutionMode {
  const fromInput =
    isPlainObject(input) && typeof input.environment === "string" ? input.environment : null;
  const env = fromInput ?? ctx.environment ?? "dev";
  return env === "dev" ? "auto" : "confirm_before_execution";
}

const PLACEHOLDER_PATTERN = /\$\{[^}]*\}/;

function stringHasPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

function walkForPlaceholder(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (depth >= SENSITIVE_DEPTH_LIMIT) return false;
  if (typeof value === "string") return stringHasPlaceholder(value);
  if (value === null || typeof value !== "object") return false;
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkForPlaceholder(item, depth + 1, seen)) return true;
    }
    return false;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (walkForPlaceholder(child, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * `confirm_before_execution` when `input.bindings` (or any nested string
 * anywhere on the input) still carries an unresolved `${…}` placeholder.
 * Running with a literal placeholder almost always means the caller
 * forgot to substitute and the request will hit the vendor with the
 * literal token in the URL / body.
 */
/** Hold-writes escape hatch: a preview that EXECUTES write-classified
 *  steps (`execute_writes: true`) publishes for real — it must carry
 *  the same explicit confirmation as any external write. The default
 *  hold-writes preview stays auto (resolves writes, dispatches none). */
export function confirmIfExecutesWrites(input: unknown): ExecutionMode {
  if (isPlainObject(input) && input.execute_writes === true) {
    return "confirm_before_execution";
  }
  return confirmIfUnresolvedPlaceholders(input);
}

export function confirmIfUnresolvedPlaceholders(input: unknown): ExecutionMode {
  // Prefer the structured `bindings` field when present — that is the
  // canonical home of substitution variables — and fall through to a
  // full walk so placeholders pasted into other slots (path, query,
  // body) are caught too.
  if (isPlainObject(input)) {
    const bindings = input.bindings;
    if (bindings !== undefined && walkForPlaceholder(bindings, 0, new WeakSet<object>())) {
      return "confirm_before_execution";
    }
  }
  return walkForPlaceholder(input, 0, new WeakSet<object>()) ? "confirm_before_execution" : "auto";
}

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

/**
 * The complete per-tool policy. Order is purely cosmetic — the resolver
 * does a single `find` by name. Tools NOT listed here resolve to
 * `auto` (permissive default).
 */
export const TOOL_POLICIES: ReadonlyArray<ToolPolicy> = [
  // ---- Destructive: always confirm ----------------------------------------
  {
    name: "delete_connector",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Permanent connector deletion",
  },
  {
    name: "delete_workflow",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Permanent workflow deletion",
  },
  {
    name: "delete_knowledge_source",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Permanent knowledge-source deletion",
  },
  {
    name: "delete_subscription",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Permanent subscription deletion",
  },
  {
    name: "delete_schedule",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Permanent schedule deletion",
  },
  {
    name: "revoke_api_key",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Revokes API key — caller loses access immediately",
  },
  {
    name: "revoke_portal_token",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Revokes portal token — caller loses access immediately",
  },
  {
    name: "approve_patch_candidate",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Applies a self-healing patch to live tenant resources",
  },
  {
    name: "approve_skill_candidate",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Promotes a skill candidate into the tenant skill library",
  },
  {
    name: "approve_discovery_artifact",
    defaultMode: "confirm_before_execution",
    confirmationKind: "destructive",
    reason: "Promotes a discovery artifact into a tenant resource",
  },

  // ---- Updates: dynamic ----------------------------------------------------
  {
    name: "update_connector",
    defaultMode: "auto",
    computeModeFromInput: confirmIfTouchesAuth,
    confirmationKind: "schema_change",
    reason: "Confirms when the patch rotates auth or repoints the base URL",
  },
  {
    name: "update_workflow",
    defaultMode: "auto",
    computeModeFromInput: confirmIfNonDevEnv,
    confirmationKind: "schema_change",
    reason: "Confirms when the patch targets a non-dev environment",
  },
  { name: "update_knowledge_source", defaultMode: "auto" },
  { name: "update_subscription", defaultMode: "auto" },
  { name: "update_schedule", defaultMode: "auto" },
  {
    name: "update_connector_draft",
    defaultMode: "auto",
    computeModeFromInput: confirmIfSensitiveInput,
    confirmationKind: "sensitive_input",
    reason: "Confirms when the draft patch carries an inline credential",
  },
  { name: "update_param", defaultMode: "auto" },

  // ---- Saves / commits: explicit save IS the diagnostic path -------------
  {
    name: "save_connector_draft",
    defaultMode: "confirm_before_execution",
    confirmationKind: "schema_change",
    reason: "Persists draft + credential atomically",
  },
  {
    name: "save_workflow_draft",
    defaultMode: "confirm_before_execution",
    confirmationKind: "schema_change",
    reason: "Persists workflow",
  },
  // ---- External calls -----------------------------------------------------
  {
    name: "call_connector",
    defaultMode: "confirm_before_execution",
    confirmationKind: "external_call",
    reason: "Invokes external API",
  },
  {
    name: "run_workflow",
    defaultMode: "auto",
    computeModeFromInput: confirmIfNonDevEnv,
    confirmationKind: "external_call",
    reason: "Confirms when running outside dev",
  },
  {
    name: "rerun_execution",
    defaultMode: "confirm_before_execution",
    confirmationKind: "external_call",
    reason: "Re-invokes the workflow's external connector calls",
  },
  {
    name: "dry_run_workflow",
    defaultMode: "auto",
    computeModeFromInput: confirmIfExecutesWrites,
    confirmationKind: "external_call",
    reason:
      "Confirms a full-live preview (execute_writes) or unresolved placeholders; hold-writes previews run auto",
  },
  {
    name: "dry_run_step",
    defaultMode: "auto",
    computeModeFromInput: confirmIfExecutesWrites,
    confirmationKind: "external_call",
    reason:
      "Confirms a full-live single-step run (execute_writes) or unresolved placeholders; hold-writes previews run auto",
  },
  { name: "dry_run_transform", defaultMode: "auto" },
  {
    name: "probe_connector",
    defaultMode: "auto",
    computeModeFromInput: confirmIfNonDevEnv,
    confirmationKind: "external_call",
    reason: "Confirms when probing outside dev",
  },
  {
    name: "probe_connector_draft",
    defaultMode: "auto",
    computeModeFromInput: confirmIfNonDevEnv,
    confirmationKind: "external_call",
  },
  {
    name: "authenticate_oauth",
    defaultMode: "confirm_before_execution",
    confirmationKind: "external_call",
    reason: "Opens an OAuth2 authorization-code flow with a third-party IdP",
  },
  {
    name: "web_search",
    defaultMode: "confirm_before_execution",
    confirmationKind: "external_call",
    reason: "Leaves the tenant perimeter via Tavily",
  },

  // ---- Discovery / read: auto --------------------------------------------
  { name: "discover_connector_endpoints", defaultMode: "auto" },
  { name: "discover_systems_from_files", defaultMode: "auto" },
  { name: "fetch_connector_docs", defaultMode: "auto" },
  { name: "search_knowledge", defaultMode: "auto" },
  { name: "search_docs", defaultMode: "auto" },
  { name: "list_connectors", defaultMode: "auto" },
  { name: "list_workflows", defaultMode: "auto" },
  { name: "list_executions", defaultMode: "auto" },
  { name: "list_schedules", defaultMode: "auto" },
  { name: "list_subscriptions", defaultMode: "auto" },
  { name: "list_knowledge_sources", defaultMode: "auto" },
  { name: "list_skills", defaultMode: "auto" },
  { name: "list_all_skills", defaultMode: "auto" },
  { name: "list_skill_candidates", defaultMode: "auto" },
  { name: "list_skill_suggestions", defaultMode: "auto" },
  { name: "list_patch_candidates", defaultMode: "auto" },
  { name: "list_discovery_artifacts", defaultMode: "auto" },
  { name: "list_audit", defaultMode: "auto" },
  { name: "list_users", defaultMode: "auto" },
  { name: "list_roles", defaultMode: "auto" },
  { name: "list_api_keys", defaultMode: "auto" },
  { name: "list_portal_tokens", defaultMode: "auto" },
  { name: "list_system_accounts", defaultMode: "auto" },
  { name: "list_attachments", defaultMode: "auto" },
  { name: "list_inbound_hooks", defaultMode: "auto" },
  { name: "get_connector", defaultMode: "auto" },
  { name: "get_workflow", defaultMode: "auto" },
  { name: "get_execution", defaultMode: "auto" },
  { name: "get_subscription", defaultMode: "auto" },
  { name: "get_knowledge_source", defaultMode: "auto" },
  { name: "get_skill", defaultMode: "auto" },
  { name: "get_skill_candidate", defaultMode: "auto" },
  { name: "get_patch_candidate", defaultMode: "auto" },
  { name: "preview_patch_candidate", defaultMode: "auto" },
  { name: "dry_run_patch_candidate", defaultMode: "auto" },
  { name: "get_discovery_artifact", defaultMode: "auto" },
  { name: "get_audit_entry", defaultMode: "auto" },
  { name: "get_role", defaultMode: "auto" },
  { name: "get_api_key", defaultMode: "auto" },
  { name: "get_inbound_hook", defaultMode: "auto" },
  { name: "get_user", defaultMode: "auto" },
  { name: "get_engine_status", defaultMode: "auto" },
  { name: "get_token_budget", defaultMode: "auto" },
  { name: "get_llm_usage", defaultMode: "auto" },
  { name: "get_raw_result", defaultMode: "auto" },
  { name: "inspect_execution_step", defaultMode: "auto" },
  { name: "get_vendor_recipe", defaultMode: "auto" },
  { name: "preview_attachment", defaultMode: "auto" },
  { name: "whoami", defaultMode: "auto" },

  // ---- Authoring helpers (draft mutations stage in-memory only) ----------
  { name: "inspect_authoring_context", defaultMode: "auto" },
  { name: "inspect_connector_draft", defaultMode: "auto" },
  { name: "inspect_workflow_draft", defaultMode: "auto" },
  { name: "validate_connector_draft", defaultMode: "auto" },
  { name: "validate_draft", defaultMode: "auto" },
  { name: "author_workflow", defaultMode: "auto" },
  { name: "build_workflow", defaultMode: "auto" },
  { name: "connect_steps", defaultMode: "auto" },
  { name: "propose_step", defaultMode: "auto" },
  { name: "propose_skill", defaultMode: "auto" },
  { name: "diagnose_latest_execution", defaultMode: "auto" },
  { name: "start_connector_from_description", defaultMode: "auto" },
  { name: "start_connector_from_template", defaultMode: "auto" },
  { name: "import_connector_from_spec", defaultMode: "auto" },
  { name: "match_connector_template_by_url", defaultMode: "auto" },
  { name: "suggest_connector_templates", defaultMode: "auto" },
  { name: "load_skill", defaultMode: "auto" },
  { name: "test_rbac_expression", defaultMode: "auto" },
  {
    name: "create_api_key",
    defaultMode: "confirm_before_execution",
    confirmationKind: "external_call",
    reason: "Mints a plaintext API key shown exactly once",
  },
  { name: "create_schedule", defaultMode: "auto" },

  // ---- Ask-user / cannot_help — never gated; they ARE the gate ----------
  { name: "ask_user_choice", defaultMode: "auto" },
  { name: "ask_user_multi", defaultMode: "auto" },
  { name: "ask_user_text", defaultMode: "auto" },
  { name: "ask_user_form", defaultMode: "auto" },
  { name: "ask_user_confirm", defaultMode: "auto" },
  { name: "cannot_help", defaultMode: "auto" },
];

const POLICY_INDEX: ReadonlyMap<string, ToolPolicy> = new Map(
  TOOL_POLICIES.map((policy) => [policy.name, policy] as const),
);

export interface ResolvedExecutionMode {
  mode: ExecutionMode;
  reason: string | null;
  confirmationKind: ConfirmationKind | null;
}

/**
 * Resolve the execution mode for a tool call.
 *
 * Precedence:
 *   1. unknown tool → `auto` (permissive default)
 *   2. `policy.computeModeFromInput(input, ctx)` if defined
 *   3. `policy.defaultMode`
 */
export function resolveExecutionMode(
  toolName: string,
  input: unknown,
  ctx: ToolPolicyContext,
): ResolvedExecutionMode {
  const policy = POLICY_INDEX.get(toolName);
  if (!policy) {
    return { mode: "auto", reason: null, confirmationKind: null };
  }
  const dynamic = policy.computeModeFromInput?.(input, ctx);
  const mode = dynamic ?? policy.defaultMode;
  return {
    mode,
    reason: policy.reason ?? null,
    confirmationKind: policy.confirmationKind ?? null,
  };
}

/** Lookup a policy entry by name. Returns `null` for unknown tools. */
export function getToolPolicy(toolName: string): ToolPolicy | null {
  return POLICY_INDEX.get(toolName) ?? null;
}
