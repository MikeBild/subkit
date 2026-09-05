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

import { classifyHttpSideEffect, type SideEffect } from "@shared/index.ts";
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

// These tenant writes only persist preparation. Anything not named here needs
// a decision, unless its input-aware policy proves that this call is a read.
const AUTO_PREPARATION_WRITES: ReadonlySet<string> = new Set([
  "save_workflow_draft",
  "create_knowledge_source",
  "analyze_knowledge_source",
]);

/**
 * Permission mode the client advertises for a turn. Overrides the
 * per-tool policy matrix:
 *   - "auto"  — preparation and input-classified reads proceed autonomously;
 *               unclassified tenant writes and dangerous calls still confirm
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
    // Lock BEFORE reading the policy document. An UPDATE only locks
    // after this read; at READ COMMITTED two writers would otherwise
    // derive their replacement JSONB from the same stale document.
    // The lock also makes the audited prior_mode the actual predecessor.
    const [row] = await tx
      .select({ tool_policies: conversations.tool_policies })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
      .limit(1)
      .for("update");
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
 * - `computeDangerFromInput` — promote the tool to "dangerous" based on
 *   the actual payload. A static name can't see that `call_connector`
 *   with `method:"PATCH"` mutates while `method:"GET"` reads; this hook
 *   lets the resolver treat the write case like a dangerous tool so the
 *   `permission_mode=auto/ask/plan` short-circuits don't auto-approve it.
 *   (yolo still honours the user's explicitly-armed override — same as
 *   for the statically-dangerous tools.)
 * - `credentialFields` — top-level dotted paths in the input that, if
 *   non-empty, force `confirm_before_execution` regardless of the
 *   user's permission_mode. Catches the "auto-mode silently persists
 *   a connector with an inline api_key" hazard.
 * - `prerequisites` — slugs of skills that must be loaded before this
 *   tool may dispatch (the load_skill gate).
 *   Resolved against `conversation.metadata.loaded_skills`.
 * - `buildPendingOutput` — when a confirm step fires, this hook turns
 *   the raw input into a structured "what will happen" preview that
 *   the elicit_request event carries on `pending_output`. Renders in
 *   the sk CLI's ConfirmPrompt as first-class fields rather than a
 *   raw JSON blob.
 */
interface ToolPolicyDefinition {
  defaultMode?: ToolPolicyMode;
  /**
   * Never gate this tool on the client's `permission_mode`.
   *
   * A `no_confirm` defaultMode alone is NOT enough: it is consulted at step 5
   * of `decideToolMode`, while the `permission_mode` short-circuit fires at
   * step 2 and gates EVERY `tenant_write`. So a client advertising `ask`/`plan`
   * re-gated tools whose pin exists precisely to keep them ungated — observed
   * in production on `load_skill` (`resolver_reason: "permission_mode"`),
   * which paused an authoring turn to confirm loading a skill into context.
   *
   * Set this only for reversible, non-dispatching tools whose own approve step
   * IS the confirmation. An explicit per-conversation override still wins (see
   * `dangerous-tools.ts` — the override is the documented opt-out mechanism),
   * so an operator who deliberately gated one of these still gets the pause.
   */
  neverGate?: boolean;
  computeModeFromInput?: (input: unknown) => ToolPolicyMode | null;
  computeDangerFromInput?: (input: unknown) => boolean;
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

/**
 * Classify a `call_connector` call as read or write from its arguments
 * alone, via the SAME shared classifier the execution engine's
 * hold-writes mechanism uses. The connector's driver is not known at
 * policy-resolution time (it's looked up at execute time), so we read the
 * intent from the args that the four driver branches consume:
 *   - postgres: `sql` (+ `allow_writes`). The tool rejects any non-SELECT
 *     unless `allow_writes:true`, so a true `allow_writes` is the explicit
 *     write signal; otherwise SELECT-detection decides.
 *   - graphql: `body.{query, operation}` — mutation/subscription = write.
 *   - http / s3: `method`. `LIST` is an S3 read (no HTTP `LIST` verb), so
 *     it maps onto the classifier's s3 read-method set.
 */
export function callConnectorSideEffect(input: unknown): SideEffect {
  const obj = asObj(input);
  if (typeof obj.sql === "string") {
    return classifyHttpSideEffect({
      override: obj.allow_writes === true ? "write" : null,
      sql: { query: obj.sql },
    });
  }
  const body = asObj(obj.body);
  if (typeof body.query === "string" || typeof body.operation === "string") {
    return classifyHttpSideEffect({
      graphql: {
        operation:
          body.operation === "query" ||
          body.operation === "mutation" ||
          body.operation === "subscription"
            ? body.operation
            : null,
        query: typeof body.query === "string" ? body.query : null,
      },
    });
  }
  const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
  return classifyHttpSideEffect({ method, s3: method === "LIST" });
}

/**
 * True when a `save_workflow_draft` call would REPLACE something that already
 * exists rather than create it: `target_workflow_id` adopts a workflow this
 * conversation did not create, `force_commit` overrules a preview that was not
 * green. Named because two policy hooks must agree on it exactly.
 */
function overwritesExistingWorkflow(input: unknown): boolean {
  const obj = asObj(input);
  return typeof obj.target_workflow_id === "string" || obj.force_commit === true;
}

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicyDefinition>> = {
  // load_skill mutates conversations.loaded_skills (category tenant_write, so it
  // audits), but it is a benign, reversible context-load the autonomous loop and
  // MCP clients must dispatch WITHOUT a confirm step. Pin no_confirm so the
  // tenant_write category default (confirm_before_execution) does not gate it.
  load_skill: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  // save_learning creates an INERT `proposed` skill candidate (human
  // review gate before anything goes live). Confirming the proposal
  // itself would gate the capture loop for no safety gain — the
  // approve step IS the confirmation.
  save_learning: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  // create_skill files an INERT `proposed` candidate too (it stopped
  // creating active skills) — same rationale as save_learning: the
  // approve step IS the confirmation.
  create_skill: {
    defaultMode: "no_confirm",
    neverGate: true,
  },
  run_workflow: {
    defaultMode: "confirm_before_execution",
    computeModeFromInput: (input) => {
      const obj = asObj(input);
      // a live write run (execute_writes:true) ALWAYS confirms, even
      // in dev: dispatching real sends/writes must be human-approved.
      // Default runs hold writes (no dispatch), so they need no confirm.
      if (obj.execute_writes === true) return "confirm_before_execution";
      // Dev-environment runs hold their writes and touch no production
      // system, so they run unattended. A prod run confirms. The ONLY
      // relaxation is the client's declared `permission_mode`, which
      // `decideToolMode` applies above this hook — this predicate never
      // reads transport metadata: `input` is the args canonicalized
      // through this tool's own Zod schema, and an out-of-band
      // auto-approve flag would be an escape hatch around the operator.
      return obj.environment === "dev" ? "no_confirm" : "confirm_before_execution";
    },
    // Makes the "ALWAYS confirms" above true. Without this, a live write run is
    // per-call hazardous but not *named* dangerous, so the
    // `permission_mode: auto` short-circuit returned `no_confirm` before
    // `computeModeFromInput` was ever consulted — dispatching real sends with
    // no human. `yolo` still honours the user's explicitly-armed override.
    computeDangerFromInput: (input) => asObj(input).execute_writes === true,
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
  propose_skill: { defaultMode: "no_confirm" },
  suggest_connector_templates: { defaultMode: "no_confirm" },
  start_connector_from_template: { defaultMode: "no_confirm" },
  start_connector_from_description: { defaultMode: "no_confirm" },
  inspect_connector_draft: { defaultMode: "no_confirm" },
  update_connector_draft: {
    defaultMode: "no_confirm",
    // RESOLVED (#304): secrets never transit the conversation transcript or
    // LLM context. Over MCP a secret-shaped elicitation is refused
    // (`secret_elicitation_blocked`, ask-user/secret-detection.ts) and
    // degrades to URL-mode elicitation or the portal DB-pause; the MCP client
    // masks poll-based forms via the `type:"password"`/`sensitive` markers
    // that `conversation_get` passes through. When an operator DOES type a
    // secret into the sanctioned CLI/web masked form, its value is projected
    // to `***redacted***` at the single persist chokepoint (resolveElicitation
    // via ask-user/redact-answer.ts) and credential subtrees in
    // save_connector_draft/update_connector_draft args are scrubbed before
    // insertToolCall (sdk-wrap/redact-tool-args.ts) — so neither the
    // elicitation row nor the tool-call row nor their LLM replay carries the
    // value. The raw value still flows in-memory into the credential cache /
    // auto-persist and is stored AES-256-GCM-encrypted. On MCP a secret-shaped
    // ask blocks (secret_elicitation_blocked) and routes to the portal flow.
    //
    // The `credentialFields` below are now doubly load-bearing: the confirm
    // gate (a draft mutation with an inline credential forces a confirm step
    // regardless of permission_mode, so the user sees what secret is staged)
    // AND the G2 arg-scrub driver (redactToolArgsForPersist).
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
  dry_run_step: { defaultMode: "no_confirm" },
  dry_run_transform: { defaultMode: "no_confirm" },
  dry_run_workflow: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      // A dry run HOLDS its writes: `hold_writes: !execute_writes` in
      // `dry-run-workflow.ts`, so every WRITE step is fully resolved but never
      // dispatched. `execute_writes: true` is the ONLY input that makes this
      // tool touch a live system, so it is the only one that needs a human.
      //
      // Gating on `environment === "prod"` instead (the previous rule) paused a
      // preview that dispatches nothing — observed in production, where a
      // 2-page probe against a held-write prod dry run demanded an approval and
      // then died unapproved. Same rationale as `run_workflow` above: "Default
      // runs hold writes (no dispatch), so they need no confirm."
      if (asObj(input).execute_writes === true) return "confirm_before_execution";
      return "no_confirm";
    },
    // A live write run is per-call dangerous, so the permission_mode
    // auto/ask/plan short-circuits must not auto-approve it before
    // `computeModeFromInput` is ever consulted (same shape as call_connector's
    // write case). `yolo` still honours the user's explicitly-armed override.
    computeDangerFromInput: (input) => asObj(input).execute_writes === true,
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
    // Creating a workflow is cheap and reversible. REPLACING one that already
    // exists destroys work that someone verified — so the two must not share a
    // gate, and `defaultMode` alone did not separate them: `permission_mode:
    // auto` short-circuits any tool that is not *dangerous*, and this one never
    // declared itself dangerous.
    //
    // Production, two calls four seconds apart, both under `auto`:
    //   save_workflow_draft{force_commit}                 → slug_conflict_with_live_workflow
    //   save_workflow_draft{force_commit, target_workflow_id} → wrote v2
    // The conflict error's own recovery text names the field that unlocks the
    // overwrite and says to use it "after the user confirms". The model used
    // the field and skipped the confirming. Four seconds is nobody being asked.
    // A recovery instruction is a request; only a gate is a gate.
    //
    // Both inputs below mean "overrule something that already holds":
    //   - `target_workflow_id` is ONLY ever supplied to adopt a workflow this
    //     conversation did not create — the escape hatch out of that conflict.
    //   - `force_commit` overrules a preview that was NOT green.
    // A plain save (new workflow, or an in-place update of the conversation's
    // own bound draft) carries neither and stays ungated.
    // BOTH hooks, mirroring `call_connector`'s write case — and the pairing is
    // load-bearing, not belt-and-braces:
    //   - `computeDangerFromInput` stops `permission_mode: auto` from
    //     short-circuiting before any hook is consulted.
    //   - `computeModeFromInput` makes the resulting confirm carry the
    //     `computed_from_input` rule. The MCP-origin collapse
    //     (`MCP_TURN_COLLAPSIBLE_WRITE_TOOLS`) applies ONLY to confirms
    //     resolved by a STATIC default, so a danger flag alone would still
    //     collapse on the very surface the incident came from.
    computeModeFromInput: (input) =>
      overwritesExistingWorkflow(input) ? "confirm_before_execution" : null,
    computeDangerFromInput: overwritesExistingWorkflow,
  },
  // Restoring replaces what is LIVE — the same consequence class as
  // overwriting, so the same gate. Dangerous too, or `permission_mode: auto`
  // would short-circuit the very confirmation this tool exists to carry.
  restore_workflow_version: {
    defaultMode: "confirm_before_execution",
    computeDangerFromInput: () => true,
  },
  author_workflow: { defaultMode: "no_confirm" },
  edit_workflow_patch: { defaultMode: "no_confirm" },
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
    // Post-execution confirmation. The OAuth
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
  // call_connector invokes a *persisted* connector with its real
  // credential. Its category is `tenant_read` (visibility), but a single
  // tool can issue a read (GET / SELECT / GraphQL query / S3 LIST) OR a
  // write (PATCH / INSERT / mutation / S3 PUT). Gate on the ACTUAL side
  // effect — the same `classifyHttpSideEffect` the engine's hold-writes
  // mechanism uses — not the static category. A read auto-runs; a write
  // confirms (and is treated as dangerous so permission_mode=auto/ask/plan
  // cannot auto-approve it; yolo still honours the user's armed override).
  call_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) =>
      callConnectorSideEffect(input) === "write" ? "confirm_before_execution" : "no_confirm",
    computeDangerFromInput: (input) => callConnectorSideEffect(input) === "write",
  },
  // web_search leaves the tenant perimeter — confirm by default.
  web_search: { defaultMode: "confirm_before_execution" },
  // probe_connector is a diagnostic call against the vendor's surface. Confirm
  // keys on the *environment*, not the HTTP method: many read APIs require POST
  // (search endpoints, GraphQL, RPC), so a method-based gate confirm-blocks
  // harmless reads while still rubber-stamping a POST that happens to write.
  // Prod probes require confirm; dev probes (the authoring sandbox) auto-run.
  probe_connector: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const env = asObj(input).environment;
      return env === "prod" ? "confirm_before_execution" : "no_confirm";
    },
  },
  probe_connector_draft: {
    defaultMode: "no_confirm",
    computeModeFromInput: (input) => {
      const env = asObj(input).environment;
      return env === "prod" ? "confirm_before_execution" : "no_confirm";
    },
  },
};

// ---------------------------------------------------------------------------
// MCP-origin confirm collapse — the enumerated write-tool partition.
//
// A conversation turn submitted over MCP runs in a queue worker with
// `surface: "mcp"`. The inner confirm gate (`sdk-wrap/confirm-decision.ts`)
// has no in-band human channel on that path: a server pause mints an
// approval no human can reach (the approval URL is discarded and the model
// is forbidden to resolve it), so the pause is a dead end — not a gate.
// The human gate on this path is the MCP CLIENT's own `destructiveHint`
// dialog on the outer `conversation_*` call, rendered BEFORE the turn
// reaches the engine.
//
// The collapse additionally applies ONLY when the confirm was resolved by a
// STATIC default rule (`tool_default` / `category_default`) — the gate in
// `decideConfirm` enforces this. A confirm produced by `inline_credential`,
// `computed_from_input`, `conversation_override`, or `permission_mode`
// always pauses, collapsible set or not: those rules encode per-call danger
// or an explicit operator ask the outer turn dialog cannot stand in for.
//
// Inclusion criterion for the collapsible set — BOTH halves must hold:
// outer MCP client destructiveHint dialog + additive/reversible effect OR
// internal hold/backstop. Concretely:
//   - additive creations (`create_*`): a bad create is visible and
//     deletable; nothing pre-existing is destroyed. The exception is
//     `create_schedule` — an unattended trigger ACTS before anyone can see
//     and delete it, so "additive" does not make it reversible.
//   - save_workflow_draft: `commitWorkflowAtomic` re-authorizes the commit
//     against the durable prior-approval predicate — a second backstop
//     behind the gate.
//
// run_workflow is deliberately NOT collapsible: every one of its confirm
// resolutions comes from `computeModeFromInput` (a live write run with
// `execute_writes:true`, or a prod run — its hook never returns null, so
// its static defaults are unreachable), and those dangerous variants must
// pause even over MCP. Safe dev hold-writes runs resolve `no_confirm` and
// never reach the gate at all.
//
// Everything else keeps pausing DELIBERATELY: every delete_*/revoke_*,
// credential/connector mutations (update_connector, authenticate_oauth,
// import_connector_from_spec, save_connector_draft — its args can stage an
// inline credential no human reviewed), user/role/api-key mutations, and
// in-place updates of existing state. Fail-closed: a confirm-capable write
// tool in NEITHER set pauses, and the invariant test
// (`tests/mcp-origin-confirm-collapse.test.ts`) fails until the new tool
// is classified here.
// ---------------------------------------------------------------------------

/**
 * Confirm-capable write tools whose `confirm_before_execution` pause
 * collapses on MCP-origin conversation turns. See the block comment above
 * for the inclusion criterion; the complement is
 * `MCP_TURN_KEEP_PAUSE_WRITE_TOOLS`.
 */
export const MCP_TURN_COLLAPSIBLE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_knowledge_source",
  "save_workflow_draft",
]);

/**
 * The documented complement: confirm-capable tools that KEEP pausing on
 * MCP-origin turns — destructive, credential-bearing, or state-mutating
 * writes where a dead-end pause is safer than an unreviewed execution.
 * Exists so the invariant test can assert every confirm-capable tool in
 * the palette is classified in exactly one of the two sets.
 */
export const MCP_TURN_KEEP_PAUSE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  // Not additive in the way the other `create_*` tools are: a schedule does
  // not sit there waiting to be noticed and deleted — it FIRES, unattended, in
  // prod, dispatching real writes on every tick. "Visible and deletable" only
  // becomes true after it has already acted.
  "create_schedule",
  // Replaces what is LIVE with an earlier version. The outer MCP dialog cannot
  // stand in for knowing WHICH version is being restored over WHAT.
  "restore_workflow_version",
  // Deletions / revocations — irreversible from within the conversation.
  "delete_connector",
  "delete_knowledge_source",
  "delete_schedule",
  "delete_skill",
  "delete_subscription",
  "delete_workflow",
  "revoke_api_key",
  "revoke_portal_token",
  // Credential / connector mutations.
  "authenticate_oauth",
  "import_connector_from_spec",
  "promote_connector",
  "save_connector_draft",
  "update_connector",
  // User / role / api-key mutations.
  "create_api_key",
  "edit_role",
  // Governance approvals — a human decision by definition.
  "approve_discovery_artifact",
  "approve_patch_candidate",
  "approve_skill_candidate",
  // In-place updates of existing tenant state.
  "update_knowledge_source",
  "update_schedule",
  "update_skill",
  "update_subscription",
  "update_workflow",
  // Re-execution / reanalysis of existing resources.
  "analyze_knowledge_source",
  "rerun_execution",
  // run_workflow: its ONLY confirm resolutions are computed_from_input
  // (live write run / prod run) — per-call danger that must pause even
  // over MCP. Safe dev hold-writes runs are no_confirm and never gate.
  "run_workflow",
  // Pinned no_confirm by default, but confirm-capable via per-conversation
  // override — an operator who explicitly gated it gets the pause honoured.
  "load_skill",
  "save_learning",
  "create_skill",
  // Dynamic confirm-capable tools (computeModeFromInput can upgrade them):
  // prod probes and connector writes go against live vendor systems.
  "call_connector",
  "dry_run_workflow",
  "probe_connector",
  "probe_connector_draft",
]);

/**
 * Which rule in the resolution stack produced the enforced mode. The
 * `tool_policy.confirmation_required` audit row records this verbatim, so
 * an operator reading the trail sees WHY a call was gated — not merely
 * that it was. Every value here names a branch of `decideToolMode`; there
 * is no second, advisory table that could disagree with it.
 */
export type ToolModeRule =
  | "inline_credential"
  | "never_gate"
  | "permission_mode"
  | "conversation_override"
  | "computed_from_input"
  | "tool_default"
  | "category_default";

export interface ToolModeDecision {
  mode: ToolPolicyMode;
  rule: ToolModeRule;
}

/**
 * Full mode-resolution stack:
 *   1. inline-credential safeguard
 *   2. never-gate pin (`neverGate`, unless an explicit override exists)
 *   3. client permission_mode ("auto" / "ask" / "plan" / "yolo") — outer gate
 *   4. per-conversation override (`conversations.tool_policies` jsonb)
 *   5. dynamic compute-from-input hook
 *   6. per-tool default mode
 *   7. category default
 *
 * The inline-credential safeguard fires FIRST and is category-independent: a
 * tool that DECLARED its credential slots (`credentialFields`) and finds one
 * filled confirms, whatever its category and whatever the client's
 * permission_mode. A `no_confirm` category default must never be the reason a
 * pasted PAT reaches a vendor unseen.
 *
 * There is deliberately no undeclared-secret heuristic here. Shape-matching
 * every string of every payload against `SECRET_PATTERNS` is a REDACTION
 * predicate, not an authorization one: it has no notion of what the call does,
 * and its high-entropy branch already once matched a legitimate base64 literal
 * inside a saved transform. Gating enforcement on it would pause `no_confirm`
 * reads like `dry_run_transform` on every iteration of an authoring session,
 * above the `yolo` short-circuit that is supposed to clear them.
 *
 * The permission_mode gate then short-circuits:
 *   - `auto` honors input-aware danger and explicit approval preferences.
 *     Only known preparation writes and dynamically classified reads proceed.
 *   - `yolo` short-circuits everything except the inline-credential safeguard
 *     above. yolo is gated at a higher layer by tenant policy +
 *     non-stickiness + expiry; by the time it reaches this resolver, the
 *     user has explicitly armed a destructive override and we honour it.
 *
 * This is the ONE enforcement table. `resolveToolMode` projects the mode
 * for callers that only gate on it; `decideToolMode` additionally names
 * the rule for the audit trail.
 */
export function decideToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
  permission_mode?: PermissionMode | null;
}): ToolModeDecision {
  const { tool, category, input, overrides, permission_mode } = args;

  const def = TOOL_POLICIES[tool];
  // A tool is dangerous if it is statically listed OR its payload makes
  // this particular call hazardous (e.g. a write via call_connector).
  // Auto cannot turn a destructive call into preparation merely because a
  // conversation persisted a no_confirm override. Yolo remains explicitly armed.
  const isDangerous = isDangerousTool(tool) || (def?.computeDangerFromInput?.(input) ?? false);

  // Inline-credential safeguard — fires before the permission_mode
  // short-circuit so `auto` cannot silently persist a secret the user
  // pasted inline. The user still sees one confirm step that surfaces
  // exactly which credential field is being staged.
  if (def?.credentialFields && hasInlineCredential(input, def.credentialFields)) {
    return { mode: "confirm_before_execution", rule: "inline_credential" };
  }

  // Never-gate tools — the pin has to survive the permission_mode
  // short-circuit below, which gates every tenant_write under "ask"/"plan"
  // and would otherwise re-gate a reversible, non-dispatching tool whose
  // whole point is to run unattended. Ordered AFTER the inline-credential
  // safeguard (a declared secret still confirms) and gated on the absence of
  // an explicit per-conversation override (that override is the documented
  // opt-out, so an operator who deliberately gated one keeps the pause).
  if (def?.neverGate && !overrides[tool]) {
    return { mode: "no_confirm", rule: "never_gate" };
  }

  if (permission_mode === "yolo") {
    // Hard-armed escape hatch. Tenant policy + client-side typed
    // confirmation + 10-turn / 10-min expiry already gated this; the
    // resolver honours the override unconditionally. The inline-credential
    // safeguard above still fires — yolo never auto-persists a credential
    // the user pasted into a declared slot.
    return { mode: "no_confirm", rule: "permission_mode" };
  }
  if (permission_mode === "auto") {
    const computed = def?.computeModeFromInput?.(input);
    if (computed === "confirm_before_execution") {
      return { mode: computed, rule: "computed_from_input" };
    }
    if (isDangerous) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
    if (
      category === "tenant_write" &&
      !AUTO_PREPARATION_WRITES.has(tool) &&
      computed !== "no_confirm"
    ) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
    const override = overrides[tool];
    if (override && override !== "no_confirm") {
      return { mode: override, rule: "conversation_override" };
    }
    return {
      mode: computed ?? "no_confirm",
      rule: computed ? "computed_from_input" : "permission_mode",
    };
  }
  if (permission_mode === "ask" || permission_mode === "plan") {
    // "plan" is surfaced to the client identically to "ask" — the UI
    // holds the confirmations until the user leaves plan mode. From
    // the engine's perspective both modes gate tenant_write on confirm.
    if (category === "tenant_write" || isDangerous) {
      return { mode: "confirm_before_execution", rule: "permission_mode" };
    }
  }

  const override = overrides[tool];
  if (override) return { mode: override, rule: "conversation_override" };
  if (def?.computeModeFromInput) {
    const computed = def.computeModeFromInput(input);
    if (computed) return { mode: computed, rule: "computed_from_input" };
  }
  if (def?.defaultMode) return { mode: def.defaultMode, rule: "tool_default" };
  return { mode: defaultModeForCategory(category), rule: "category_default" };
}

/**
 * The enforced execution mode for a tool call. Called from `sdk-wrap.ts`
 * and `policyDecide` before every tool dispatch.
 */
export function resolveToolMode(args: {
  tool: string;
  category: "draft_write" | "tenant_read" | "tenant_write";
  input: unknown;
  overrides: ToolPolicies;
  permission_mode?: PermissionMode | null;
}): ToolPolicyMode {
  return decideToolMode(args).mode;
}

/**
 * Approval-mode badge for the discoverable `/policy` panel. Distinct
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
