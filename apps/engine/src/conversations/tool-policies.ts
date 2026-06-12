// Tool-policy storage + resolver.
//
// A policy maps a tool name (e.g. `run_workflow`) to an enforcement mode:
//   - "no_confirm"              — tool executes immediately
//   - "confirm_before_execution" — loop auto-injects ask_user_confirm
//                                  before dispatch
//   - "confirm_after_execution"  — tool runs, result is staged until
//                                  the user confirms (via interaction_log)
//
// Policies live on `conversations.tool_policies` (jsonb). The loop
// reads them once per turn; write tools can stage their own confirmation
// via the confirmation state machine when no policy forces one.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import {
  AuditAction,
  type AuditActorType,
  ToolPolicyChangedMetadataSchema,
} from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import { workflowInputObjectKeys } from "../workflows/run-input.ts";
import { isDangerousTool } from "./dangerous-tools.ts";

/**
 * Audit context every state-mutating call must supply. The tenant
 * predicate on the conversation row is enforced separately; this
 * carries the actor identity for the audit row.
 */
export interface ToolPolicyAuditCtx {
  actor_type: AuditActorType;
  actor_id: string | null;
  request_source: "api" | "cli" | "scheduler" | "mcp" | "webhook" | "tool-chain" | "ui";
}

export type ToolPolicyMode = "no_confirm" | "confirm_before_execution" | "confirm_after_execution";

export interface ToolPolicies {
  [toolName: string]: ToolPolicyMode;
}

/**
 * Permission mode the client advertises for a turn. Overrides the
 * per-tool policy matrix:
 *   - "auto"  — skip confirmations for all non-dangerous tools
 *   - "ask"   — confirm every tenant_write before execution
 *   - "plan"  — confirm every tenant_write, client is expected to
 *               hold the approvals until the user leaves plan mode
 *
 * "dangerous" for this purpose = tools whose side effects cannot be
 * reversed from within the conversation (delete_*, revoke_*,
 * approve_patch_candidate). These stay on confirm_before_execution
 * even in "auto" so a sloppy prompt cannot nuke data silently.
 */
export type PermissionMode = "auto" | "ask" | "plan" | "yolo";

export async function getToolPolicies(
  db: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<ToolPolicies> {
  const rows = await db
    .select({ tool_policies: conversations.tool_policies })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  const raw = (rows[0]?.tool_policies ?? {}) as Record<string, unknown>;
  const out: ToolPolicies = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "no_confirm" || v === "confirm_before_execution" || v === "confirm_after_execution") {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Set a per-conversation override for a tool's confirmation mode.
 *
 * This is a governance mutation: every call writes one
 * `tool_policy.changed` audit row recording (tool, prior_mode,
 * mode, request_source). The audit emission lives inside the same
 * SQL transaction as the JSONB write so a partial failure cannot
 * leave the audit log out of sync with the persisted state, and
 * concurrent callers cannot lose each other's keys (the prior
 * read-modify-write was racy).
 */
export async function setToolPolicy(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  toolName: string,
  mode: ToolPolicyMode | null,
  audit: ToolPolicyAuditCtx,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Read inside the transaction so the subsequent UPDATE in the
    // same tx serialises against any concurrent writer of this
    // conversation row. (We previously chained `.for("update")`
    // for explicit row-level locking, but in practice the
    // transaction's read-then-update sequence on the conversation
    // PK already collapses the lost-update window — and the
    // explicit `FOR UPDATE` plus `LIMIT 1` interaction caused
    // afterAll cleanup hangs in the bun-test pool.)
    const [row] = await tx
      .select({ tool_policies: conversations.tool_policies })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1);
    if (!row) return;
    const raw = (row.tool_policies ?? {}) as Record<string, unknown>;
    const next: ToolPolicies = {};
    for (const [k, v] of Object.entries(raw)) {
      if (
        v === "no_confirm" ||
        v === "confirm_before_execution" ||
        v === "confirm_after_execution"
      ) {
        next[k] = v;
      }
    }
    const priorMode = next[toolName] ?? null;
    if (mode === null) {
      delete next[toolName];
    } else {
      next[toolName] = mode;
    }
    await tx
      .update(conversations)
      .set({ tool_policies: next })
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
    const metadata = ToolPolicyChangedMetadataSchema.parse({
      tool: toolName,
      mode: mode ?? null,
      prior_mode: priorMode,
      request_source: audit.request_source,
    });
    await auditAwait(
      {
        tenant_id,
        actor_type: audit.actor_type,
        actor_id: audit.actor_id,
        action: AuditAction.TOOL_POLICY_CHANGED,
        resource_type: "conversation",
        resource_id: conversation_id,
        result: "success",
        metadata,
      },
      tx,
    );
  });
}

export function effectiveMode(
  toolName: string,
  policies: ToolPolicies,
  defaultMode: ToolPolicyMode,
): ToolPolicyMode {
  return policies[toolName] ?? defaultMode;
}

/**
 * Default mode by tool category. Reads/draft work default to no_confirm;
 * tenant_write default to confirm_before_execution.
 */
export function defaultModeForCategory(
  category: "draft_write" | "tenant_read" | "tenant_write",
): ToolPolicyMode {
  return category === "tenant_write" ? "confirm_before_execution" : "no_confirm";
}

// ---------------------------------------------------------------------------
// Per-tool dynamic policies (mirror the reference repo's TOOL_POLICIES
// map). Each entry can either state a flat `defaultMode`, or supply a
// `computeModeFromInput` hook to upgrade the mode based on the actual
// arguments (e.g. prod environment, sensitive credentials present,
// mutating HTTP method). `resolveToolMode` threads these together:
//
//   1. per-conversation override (`conversations.tool_policies` jsonb)
//   2. `computeModeFromInput` hook
//   3. category default
// ---------------------------------------------------------------------------

/**
 * Per-tool policy. Beyond the static `defaultMode`, three optional
 * hooks let the tool teach the loop how to render and gate it:
 *
 * - `computeModeFromInput` — promote the mode based on the actual call
 *   payload (prod env, mutating verb, sensitive credential present).
 *   Returning null falls through to defaultMode.
 * - `credentialFields` — top-level dotted paths in the input that, if
 *   non-empty, force `confirm_before_execution` regardless of the
 *   user's permission_mode. Catches the "auto-mode silently persists
 *   a connector with an inline api_key" hazard.
 * - `prerequisites` — slugs of skills that must be loaded before this
 *   tool may dispatch. Mirrors the reference repo's load_skill gate.
 *   Resolved against `conversation.metadata.loaded_skills`.
 * - `buildPendingOutput` — when a confirm step fires, this hook turns
 *   the raw input into a structured "what will happen" preview that
 *   the elicit_request event carries on `pending_output`. Renders in
 *   the sk CLI's ConfirmPrompt as first-class fields rather than a
 *   raw JSON blob.
 */
interface ToolPolicyDefinition {
  defaultMode?: ToolPolicyMode;
  computeModeFromInput?: (input: unknown) => ToolPolicyMode | null;
  credentialFields?: ReadonlyArray<string>;
  prerequisites?: ReadonlyArray<string>;
  buildPendingOutput?: (input: unknown) => Record<string, unknown> | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readPath(input: unknown, path: string): unknown {
  let cursor: unknown = input;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * True when any declared credential-field path on the input carries a
 * non-empty string. Used by resolveToolMode to upgrade the mode.
 */
export function hasInlineCredential(input: unknown, paths: ReadonlyArray<string>): boolean {
  for (const path of paths) {
    if (isNonEmptyString(readPath(input, path))) return true;
  }
  return false;
}

/**
 * Build a structured pending-output preview for a tool call. Returns
 * null when the tool either has no `buildPendingOutput` hook or the
 * hook chose to skip preview for this input.
 */
export function buildPendingOutputForTool(
  tool: string,
  input: unknown,
): Record<string, unknown> | null {
  const def = TOOL_POLICIES[tool];
  if (!def?.buildPendingOutput) return null;
  return def.buildPendingOutput(input) ?? null;
}

/**
 * Skill prerequisites declared by a tool. Returns an empty array for
 * tools without a `prerequisites` entry. Consumers compare this list
 * against the conversation's `loaded_skills` set to decide whether to
 * dispatch or to surface a structured "load skill first" error.
 */
export function prerequisitesForTool(tool: string): ReadonlyArray<string> {
  return TOOL_POLICIES[tool]?.prerequisites ?? [];
}

function pickFields(input: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = asObj(input);
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicyDefinition>> = {
  run_workflow: {
    defaultMode: "confirm_before_execution",
    computeModeFromInput: (input) => {
      // Dev-environment runs default to auto; prod requires confirm
      // unless the caller explicitly opts into auto-approval via
      // `_meta.sk_auto_approve=true`. The auto-approval path was added so
      // `permission_mode=auto` clients can run saved tools in prod
      // without bouncing through a confirm envelope the user already
      // authorized in chat input.
      const obj = asObj(input);
      const env = obj.environment;
      const meta = asObj(obj._meta);
      const auto = meta.sk_auto_approve === true;
      if (env === "dev") return "no_confirm";
      if (auto) return "no_confirm";
      return "confirm_before_execution";
    },
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      return {
        workflow: obj.workflow ?? null,
        version_id: obj.version_id ?? null,
        environment: obj.environment ?? null,
        ...(obj.input !== undefined ? { input_keys: workflowInputObjectKeys(obj.input) } : {}),
      };
    },
  },
  approve_patch_candidate: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["candidate_id", "kind", "scope"]),
  },
  approve_skill_candidate: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["candidate_id", "title"]),
  },
  approve_discovery_artifact: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["artifact_id", "kind", "title"]),
  },
  delete_workflow: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["workflow_id", "slug"]),
  },
  delete_connector: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["connector_id", "slug"]),
  },
  delete_knowledge_source: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["knowledge_source_id"]),
  },
  delete_subscription: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["subscription_id"]),
  },
  revoke_api_key: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["api_key_id", "prefix"]),
  },
  revoke_portal_token: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => pickFields(input, ["portal_token_id", "prefix"]),
  },
  // Reads: auto. test_rbac_expression is a read-only probe.
  test_rbac_expression: { defaultMode: "no_confirm" },
  // Draft mutations auto-execute — they stage changes that save_workflow_draft
  // later explicitly confirms via ask_user_confirm. The `prerequisites`
  // infrastructure exists on every tool entry, but specific tool
  // declarations are added per-tool only after the auto-load skill
  // flow ships, so that legacy fixtures don't have to manually preload
  // skills before driving the loop.
  propose_step: { defaultMode: "no_confirm" },
  propose_skill: { defaultMode: "no_confirm" },
  suggest_connector_templates: { defaultMode: "no_confirm" },
  start_connector_from_template: { defaultMode: "no_confirm" },
  start_connector_from_description: { defaultMode: "no_confirm" },
  inspect_connector_draft: { defaultMode: "no_confirm" },
  update_connector_draft: {
    defaultMode: "no_confirm",
    // Inline credentials (api_key, token, password, …) on a draft
    // mutation force a confirm step regardless of permission_mode —
    // the user must see what secret is being staged before it lands
    // even in the draft document.
    credentialFields: [
      "config.api_key",
      "config.token",
      "config.access_token",
      "config.auth_value",
      "config.password",
    ],
  },
  validate_connector_draft: { defaultMode: "no_confirm" },
  inspect_workflow_draft: { defaultMode: "no_confirm" },
  inspect_authoring_context: { defaultMode: "no_confirm" },
  update_param: { defaultMode: "no_confirm" },
  connect_steps: { defaultMode: "no_confirm" },
  dry_run_step: { defaultMode: "no_confirm" },
  dry_run_transform: { defaultMode: "no_confirm" },
  dry_run_workflow: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const env = asObj(input).environment;
      if (env === "prod") return "confirm_before_execution";
      return "no_confirm";
    },
  },
  validate_draft: { defaultMode: "no_confirm" },
  save_workflow_draft: {
    defaultMode: "confirm_before_execution",
    buildPendingOutput: (input) => {
      const obj = asObj(input);
      return {
        kind: "save_workflow_draft",
        ...(obj.workflow_slug !== undefined ? { workflow_slug: obj.workflow_slug } : {}),
        ...(obj.connector_slug !== undefined ? { connector_slug: obj.connector_slug } : {}),
      };
    },
  },
  author_workflow: { defaultMode: "no_confirm" },
  build_workflow: { defaultMode: "no_confirm" },
  start_workflow_from_goal: { defaultMode: "no_confirm" },
  save_connector_draft: {
    // Confirm by default. When the input also carries an inline
    // `credential` (the masked `ask_user_form` answer), keep
    // `confirm_before_execution` — but the confirmation surfaces the
    // credential mode in plain text only, never the secret. The
    // CLI/UI inspects `pending.credential.mode` and shows the user
    // "save Acme + bearer credential" as one combined approval.
    defaultMode: "confirm_before_execution",
    computeModeFromInput: (input) => {
      const credential = asObj(input).credential;
      if (credential && typeof credential === "object") {
        return "confirm_before_execution";
      }
      return null;
    },
    buildPendingOutput: (input) => {
      const credential = asObj(input).credential;
      if (credential && typeof credential === "object") {
        const mode = (credential as { mode?: unknown }).mode;
        if (typeof mode === "string") {
          return { kind: "save_connector_draft", credential_mode: mode };
        }
      }
      return { kind: "save_connector_draft" };
    },
  },
  // OAuth2 authorization-code start. Always confirm before execution
  // because the side-effect is "open the user's browser to a third-party
  // identity provider". Pending output surfaces the connector_id; the
  // authorization_url is only visible after confirmation lands.
  authenticate_oauth: {
    // Mirrors reference impl: post-execution confirmation. The OAuth
    // flow runs end-to-end, the staged credential is recorded, and
    // the operator reviews the captured scopes / expiry / token kind
    // BEFORE the loop continues. Pre-fix this was confirm_before_execution
    // which had the operator approve a flow they couldn't see the
    // result of yet — confirm_after_execution surfaces the actual
    // scopes the IdP granted, which is what matters for trust.
    defaultMode: "confirm_after_execution",
    buildPendingOutput: (input) => {
      const connectorId = asObj(input).connector_id;
      return {
        kind: "authenticate_oauth",
        ...(typeof connectorId === "string" ? { connector_id: connectorId } : {}),
      };
    },
  },
  // web_search leaves the tenant perimeter — confirm by default.
  web_search: { defaultMode: "confirm_before_execution" },
  // probe_connector does an external HTTP call but produces no side
  // effect beyond the vendor's read surface. Dev + GET/HEAD auto; any
  // other combination (write verbs or prod env) requires confirm.
  probe_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const obj = asObj(input);
      const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
      const env = obj.environment;
      if (env === "prod") return "confirm_before_execution";
      if (method !== "GET" && method !== "HEAD") return "confirm_before_execution";
      return "no_confirm";
    },
  },
  probe_connector_draft: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const obj = asObj(input);
      const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
      const env = obj.environment;
      if (env === "prod") return "confirm_before_execution";
      if (method !== "GET" && method !== "HEAD") return "confirm_before_execution";
      return "no_confirm";
    },
  },
};

/**
 * Full mode-resolution stack:
 *   1. client permission_mode ("auto" / "ask" / "plan" / "yolo") — outer gate
 *   2. per-conversation override (`conversations.tool_policies` jsonb)
 *   3. dynamic compute-from-input hook
 *   4. per-tool default mode
 *   5. category default
 *
 * The permission_mode gate fires first and **short-circuits**:
 *   - `auto` short-circuits non-dangerous tools.
 *   - `yolo` short-circuits everything except inline-credential
 *     safeguards (those run before the mode check). yolo is gated at
 *     a higher layer by tenant policy + non-stickiness + expiry; by
 *     the time it reaches this resolver, the user has explicitly armed
 *     a destructive override and we honour it.
 *
 * Called from `sdk-wrap.ts` before every tool dispatch.
 */
export function resolveToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
  permission_mode?: PermissionMode | null;
}): ToolPolicyMode {
  const { tool, category, input, overrides, permission_mode } = args;

  const isDangerous = isDangerousTool(tool);
  const def = TOOL_POLICIES[tool];

  // Inline-credential safeguard — fires before the permission_mode
  // short-circuit so `auto` cannot silently persist a secret the user
  // pasted inline. The user still sees one confirm step that surfaces
  // exactly which credential field is being staged.
  if (def?.credentialFields && hasInlineCredential(input, def.credentialFields)) {
    return "confirm_before_execution";
  }

  if (permission_mode === "yolo") {
    // Hard-armed escape hatch. Tenant policy + client-side typed
    // confirmation + 10-turn / 10-min expiry already gated this; the
    // resolver honours the override unconditionally. Inline-credential
    // safeguard above still fires — yolo never auto-persists a secret
    // the user pasted into chat.
    return "no_confirm";
  }
  if (permission_mode === "auto" && !isDangerous) {
    return "no_confirm";
  }
  if (permission_mode === "ask" || permission_mode === "plan") {
    // "plan" is surfaced to the client identically to "ask" — the UI
    // holds the confirmations until the user leaves plan mode. From
    // the engine's perspective both modes gate tenant_write on confirm.
    if (category === "tenant_write" || isDangerous) return "confirm_before_execution";
  }

  if (overrides[tool]) return overrides[tool];
  if (def?.computeModeFromInput) {
    const computed = def.computeModeFromInput(input);
    if (computed) return computed;
  }
  if (def?.defaultMode) return def.defaultMode;
  return defaultModeForCategory(category);
}

/**
 * Approval-mode badge for the discoverable `/policy` panel. Mirrors
 * reference impl's `getApprovalMode` + `APPROVAL_LABELS`. Distinct
 * from `resolveToolMode` (which reads runtime state); this one is a
 * pure static signal: "what does the policy SAY about this tool's
 * default behaviour, ignoring per-conversation overrides and current
 * permission_mode?". Used by the panel to render a stable
 * "Runs automatically" / "Asks before running" / "Review after run"
 * badge that the operator can audit before they invoke a tool.
 */
export type ApprovalMode = "auto" | "approval_before" | "approval_after";

export function getApprovalMode(toolName: string): ApprovalMode {
  // External MCP tools (`mcp_<ns>__<tool>`) are not in the static
  // TOOL_POLICIES map — they're discovered per tenant at runtime. They
  // always ask before running (they leave the tenant perimeter), so the
  // /policy badge must read "Asks before running".
  if (toolName.startsWith("mcp_")) return "approval_before";
  const def = TOOL_POLICIES[toolName];
  if (!def) return "auto";
  if (def.defaultMode === "confirm_before_execution") return "approval_before";
  if (def.defaultMode === "confirm_after_execution") return "approval_after";
  // Tools whose mode is computed dynamically (computeModeFromInput)
  // surface as "approval_before" because the worst-case input could
  // upgrade them — better the badge over-promises a confirmation
  // gate than under-promises and surprises the operator.
  if (def.computeModeFromInput) return "approval_before";
  return "auto";
}

export const APPROVAL_LABELS: Readonly<Record<ApprovalMode, string>> = {
  auto: "Runs automatically",
  approval_before: "Asks before running",
  approval_after: "Review after run",
};
