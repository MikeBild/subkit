// Skill-gated tool palette.
//
// Replaces the old state-gated palette. The design:
//
//   1. Tools never silently disappear once a skill has been loaded.
//   2. Loading the right skill exposes a fixed tool set; calling a
//      tool against the wrong state returns a structured
//      `tool_unavailable_in_state` envelope from `state-gate.ts`.
//   3. The palette resolution is purely additive — the union of
//      always-visible tools, the cleanup set, and whatever sets the
//      currently-loaded skills unlock.
//
// Background — session 00b93a52 ended with the agent saying
// "save_connector_draft is not available in the current tool palette"
// and asking the user to restart. The dead-end was caused by the old
// `connectorDraftAllowsSave()` predicate hiding `save_connector_draft`
// whenever the probe checkpoint was stale. The new contract: expose
// the tool, let the tool's input contract return a structured
// `probe_failed` envelope with `next_best_actions`, and let the LLM
// recover within the same turn.

import type { DraftDocument } from "../types.ts";
import type { ConversationTool } from "./index.ts";

export const CONNECTOR_AUTHORING_SKILL = "connector-creation-guidance";
export const WORKFLOW_AUTHORING_SKILL = "workflow-authoring";

/**
 * Prefix for the synthetic `wf_<slug>` saved-workflow tools. Single source of
 * truth, shared with `sdk-wrap/synthetic-workflow-tools.ts` (which builds them)
 * and the execution-tool gate below (which removes them), so the prefix can
 * never drift between producer and gate.
 */
export const WORKFLOW_TOOL_PREFIX = "wf_";

/**
 * Tools that are always visible regardless of skill-load state.
 * Cover meta-tools (ask_user_*, cannot_help, list_skills, load_skill),
 * passive reads, and the connector-template / docs surfaces the model
 * needs at any point in a conversation.
 */
const ALWAYS_VISIBLE: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_form",
  "ask_user_multi",
  "ask_user_text",
  "cannot_help",
  "discover_connector_endpoints",
  "discover_systems_from_files",
  "fetch_connector_docs",
  "get_raw_result",
  "inspect_authoring_context",
  "list_attachments",
  "list_skills",
  "load_skill",
  "preview_attachment",
  // A dead connector credential can surface in ANY conversation, so the
  // recovery tool must always be reachable. It is `draft_write` (the
  // non-OAuth path stages a credential re-issue draft), so the
  // `tenant_read` catch-all in filterByAuthoringPalette no longer keeps it
  // visible — list it explicitly.
  "request_connector_reauth",
  "search_knowledge",
  "suggest_connector_templates",
]);

/**
 * Read-only tools that surface tenant resources and probes — always
 * available so the model can introspect state at any time without
 * needing to load a skill first.
 */
const RELEVANT_READS: ReadonlySet<string> = new Set([
  "call_connector",
  "get_connector",
  "get_execution",
  "get_workflow",
  "inspect_execution_step",
  "list_connectors",
  "list_executions",
  "list_workflows",
  "probe_connector",
]);

/**
 * Cleanup + generic-update operations. Execution mode is decided by
 * `tool-policies.ts`; visibility is unconditional so the user can
 * always say "lösche dummy-http" mid-conversation regardless of the
 * authoring stage.
 *
 * Schedule writes live here too. `turn-routing.ts` answers "schedule a
 * workflow" with `create_schedule` / `update_schedule` / `delete_schedule`;
 * keeping them out of the allow-set was the same contract drift the
 * file header warns against — the LLM would name a tool the SDK
 * palette didn't carry, then fail with "tool not in palette" mid-turn.
 * `list_schedules` reaches the LLM via the `tenant_read` clause below.
 */
const ALWAYS_AVAILABLE_CLEANUP: ReadonlySet<string> = new Set([
  "analyze_knowledge_source",
  "create_knowledge_source",
  "create_schedule",
  "delete_connector",
  "delete_knowledge_source",
  "delete_schedule",
  "delete_subscription",
  "delete_workflow",
  "revoke_api_key",
  "revoke_portal_token",
  "update_connector",
  "update_knowledge_source",
  "update_schedule",
  "update_subscription",
  "update_workflow",
]);

/** Connector authoring tools — exposed once `connector-creation-guidance` is loaded. */
const CONNECTOR_AUTHORING: ReadonlySet<string> = new Set([
  "inspect_connector_draft",
  "probe_connector_draft",
  "start_connector_from_description",
  "start_connector_from_template",
  "update_connector_draft",
  "validate_connector_draft",
]);

/** Persistence tool — paired with the connector-authoring skill. The
 *  tool itself enforces credential + probe preconditions via
 *  `state-gate.ts` and the in-tool `force_save` escape hatch. */
const CONNECTOR_PERSISTENCE: ReadonlySet<string> = new Set(["save_connector_draft"]);

/** OAuth dance — exposed alongside connector authoring; the tool gates
 *  with `oauth_not_configured` when called against a non-OAuth
 *  connector. */
const CONNECTOR_OAUTH: ReadonlySet<string> = new Set(["authenticate_oauth"]);

/** Workflow authoring tools — exposed once `workflow-authoring` is loaded.
 *  The triad: `author_workflow` is THE builder (one-shot grounded
 *  pipeline), `edit_workflow_patch` is THE editor (RFC 6902 JSON Patch
 *  over the whole draft — append a step, retarget refs, set any single
 *  field/header, add an edge), and `dry_run_workflow` (in WORKFLOW_PREVIEW)
 *  is the always-available runner. */
const WORKFLOW_AUTHORING: ReadonlySet<string> = new Set([
  "author_workflow",
  "edit_workflow_patch",
  "inspect_workflow_draft",
  // Clone a builtin/tenant recipe into the draft. It is a draft_write
  // tool like author_workflow and only clones a tenant-scoped recipe;
  // safe to expose.
  "start_workflow_from_recipe",
  "validate_draft",
]);

/** Dry-run tools — paired with workflow authoring. */
const WORKFLOW_PREVIEW: ReadonlySet<string> = new Set([
  "dry_run_step",
  "dry_run_transform",
  "dry_run_workflow",
]);

/** Workflow commit — paired with workflow authoring. The tool itself
 *  enforces preview + validation via `state-gate.ts` and the in-tool
 *  `force_commit` escape hatch. */
const WORKFLOW_PERSISTENCE: ReadonlySet<string> = new Set(["save_workflow_draft"]);

/** Diagnosis — paired with workflow authoring. The tool itself emits a
 *  `tool_unavailable_in_state` envelope when no execution exists. */
const DIAGNOSIS_TOOLS: ReadonlySet<string> = new Set(["diagnose_latest_execution"]);

/**
 * Execution-tier tools that are always visible regardless of skill load
 * state. `run_workflow` lives here so a fresh conversation that names a
 * saved workflow ("run acme-jira-test-plans") can dispatch it on the
 * first LLM turn without first loading `workflow-authoring`. Same
 * treatment `delete_workflow` already has in ALWAYS_AVAILABLE_CLEANUP.
 * The tool's input contract still resolves the slug against the live
 * workflows table, and the confirm gate (`tools/policy.ts`) still applies
 * before the run actually fires.
 */
const ALWAYS_AVAILABLE_EXECUTION: ReadonlySet<string> = new Set(["run_workflow"]);

function addNames(target: Set<string>, names: ReadonlySet<string>): void {
  for (const name of names) target.add(name);
}

/**
 * Resolve the visible tool palette for one turn.
 *
 * The palette is purely a function of:
 *   - the always-visible base set (meta-tools, reads, cleanup),
 *   - which authoring skills are currently loaded.
 *
 * Authoring tools come into scope when their owning skill is loaded
 * and STAY in scope for the rest of the conversation. The draft state
 * is irrelevant to visibility — wrong-state calls return a structured
 * envelope from `state-gate.ts` rather than disappearing from the
 * palette. See `state-gate.ts` for the recovery contract.
 *
 * @param tools         — the registered tool list (`listTools()`).
 * @param _draft        — the conversation's draft (unused; kept on the
 *                        signature for symmetry with the old API and to
 *                        leave room for future per-resource gating).
 * @param loadedSkills  — slugs of skills currently loaded. Pass an
 *                        empty set on a fresh conversation; the loop
 *                        seeds the canonical authoring slugs so a
 *                        first-message "create a connector" intent
 *                        already sees the connector palette.
 */
export function filterByAuthoringPalette<
  T extends { name: string; category?: ConversationTool["category"] },
>(tools: readonly T[], _draft: DraftDocument, loadedSkills: ReadonlySet<string>): T[] {
  const allowed = new Set<string>();
  addNames(allowed, ALWAYS_VISIBLE);
  addNames(allowed, RELEVANT_READS);
  addNames(allowed, ALWAYS_AVAILABLE_CLEANUP);
  addNames(allowed, ALWAYS_AVAILABLE_EXECUTION);

  if (loadedSkills.has(CONNECTOR_AUTHORING_SKILL)) {
    addNames(allowed, CONNECTOR_AUTHORING);
    addNames(allowed, CONNECTOR_PERSISTENCE);
    addNames(allowed, CONNECTOR_OAUTH);
  }
  if (loadedSkills.has(WORKFLOW_AUTHORING_SKILL)) {
    addNames(allowed, WORKFLOW_AUTHORING);
    addNames(allowed, WORKFLOW_PREVIEW);
    addNames(allowed, WORKFLOW_PERSISTENCE);
    addNames(allowed, DIAGNOSIS_TOOLS);
  }
  // tenant_read tools are tenant-scoped, side-effect-free, and parallelisable.
  // They should always be reachable so the LLM can introspect tenant state at
  // any point — listing workflows, fetching audit entries, checking engine
  // status, browsing knowledge sources. Filtering them by skill would create
  // dead-ends for ordinary "what's there?" turns.
  return tools.filter((tool) => allowed.has(tool.name) || tool.category === "tenant_read");
}

// ── Chat read-only palette ──────────────────────────────────────────────────
//
// External chat channels (Google Chat, Slack, Teams) are a channel-scoped
// READ-ONLY surface: query tenant state, run saved workflows, plain LLM
// chat — never author, never mutate, never call connectors directly. The
// restriction is structural (palette-level), NOT role-level: an
// admin-linked chat identity gets the same set. RBAC stays the second,
// per-user layer underneath.

/**
 * The channel-scoped read-only palette for `surface: "chat"`.
 *
 * A pure NAME allow-list — deliberately independent of `loadedSkills`
 * AND of `tool.category`, so that (a) `load_skill`-ing an authoring
 * skill can never unlock authoring tools, and (b) a future
 * `tenant_read`-categorised tool is NOT auto-exposed (fail-closed; the
 * category catch-all in `filterByAuthoringPalette` does not apply here).
 *
 * Deliberately EXCLUDED, with reasons:
 *  - `call_connector` — categorised `tenant_read` but issues live
 *    connector calls including writes; the channel contract forbids
 *    direct connector use entirely.
 *  - `probe_connector`, `test_connector`, `discover_connector_endpoints`,
 *    `discover_systems_from_files`, `fetch_connector_docs`,
 *    `fetch_connector_self_description`, `suggest_connector_templates`,
 *    `match_connector_template_by_url`, `analyze_scrape_target` —
 *    connector-authoring aids and live probes.
 *  - `authenticate_oauth`, `request_connector_reauth` — credential flows.
 *  - `inspect_authoring_context`, `diagnose_latest_execution`,
 *    `list_draft_snapshots` — authoring-session surfaces.
 *  - every `draft_write` / `tenant_write` tool (author/edit/save/update/
 *    delete/create/revoke/approve) — the channel never mutates.
 *  - external MCP tools — write-capable; gated in `sdk-wrap.ts`.
 *
 * `run_workflow` and the synthetic `wf_<slug>` peers stay: running a
 * saved workflow is the channel's one action, and it remains behind
 * `resolveExecutionToolGate`, per-user RBAC (`gateWorkflowRunRbac`), and
 * the confirm policy (rendered as a chat approval card).
 */
export const CHAT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  // conversational meta
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_form",
  "ask_user_multi",
  "ask_user_text",
  "cannot_help",
  "list_skills",
  "load_skill",
  "list_attachments",
  "preview_attachment",
  "get_raw_result",
  // knowledge + docs (read)
  "search_knowledge",
  "search_docs",
  "list_knowledge_sources",
  "get_knowledge_source",
  // The follow-up to a search hit ("read me the deploy runbook"): pages
  // through a source's full content, `path`-addressable for one file of an
  // imported bundle. Read-only, `knowledge:read`-gated, byte-bounded per
  // call — the same posture as the search above it.
  "read_knowledge",
  // workflows (read)
  "list_workflows",
  "get_workflow",
  "find_workflow",
  // executions (read)
  "list_executions",
  "get_execution",
  "inspect_execution",
  "inspect_execution_step",
  // connectors — METADATA only
  "list_connectors",
  "get_connector",
  "find_connector",
  // skills (read)
  "get_skill",
  "find_skill",
  // schedules (read)
  "list_schedules",
  // execution dispatch — gated by execution-tool gate + RBAC + confirm
  "run_workflow",
]);

/**
 * Resolve the visible palette for a chat-surface turn. Unlike
 * `filterByAuthoringPalette` this takes no draft and no loadedSkills —
 * the chat palette is constant for the lifetime of the channel.
 */
export function filterByChatReadOnlyPalette<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => CHAT_READONLY_TOOLS.has(tool.name));
}

// ── Execution-tool gate ─────────────────────────────────────────────────────
//
// `run_workflow` and every synthetic `wf_<slug>` peer EXECUTE an existing
// saved workflow. In an authoring conversation that has no run target, leaving
// them in the palette lets the model "satisfy" a build request by running the
// closest lookalike workflow and stalling on its input form — the
// notion-essay-to-markdown / page_id hijack. The previous guard keyed this on a
// brittle, negation-blind, single-message regex (a positive "build new" match),
// so a negated build request ("...do NOT run...") or a weak continuation
// ("retry to create from scratch now") slipped past it.
//
// The gate below is DEFAULT-DENY and keyed only on DURABLE conversation state,
// never on free-text run/authoring phrasing: execution tools are exposed iff a
// saved workflow is bound to the conversation, or the user named a real
// saved-workflow slug this turn. A negation can satisfy neither, so the whole
// negation-blindness class is closed structurally rather than by patching
// regexes.

export interface ExecutionToolGateState {
  /**
   * True when the conversation currently has a saved-workflow run target — a
   * turn `workflow_id`, or an `active_target` that is a PERSISTED workflow.
   * Sticky `persisted_resources` history must NOT be used here: the gate asks
   * "is there a run target right now", not "was one ever saved".
   */
  hasBoundSavedWorkflow: boolean;
  /** A saved-workflow slug the user named verbatim this turn, or null. */
  explicitlyNamedWorkflowSlug: string | null;
}

export interface ExecutionToolGateDecision {
  exposeExecution: boolean;
  reason: "bound_saved_workflow" | "named_workflow_slug" | "chat_surface" | "authoring_no_target";
}

/**
 * Decide whether execution tools are exposed this turn. Pure; no I/O. See the
 * block comment above for the design rationale.
 */
export function resolveExecutionToolGate(state: ExecutionToolGateState): ExecutionToolGateDecision {
  if (state.hasBoundSavedWorkflow) {
    return { exposeExecution: true, reason: "bound_saved_workflow" };
  }
  if (state.explicitlyNamedWorkflowSlug != null) {
    return { exposeExecution: true, reason: "named_workflow_slug" };
  }
  return { exposeExecution: false, reason: "authoring_no_target" };
}

/**
 * True for the literal `run_workflow` tool and for any synthetic `wf_<slug>`
 * peer whose slug is in the live catalog. Imports the prefix constant rather
 * than hardcoding `"wf_"`, so it stays correct if the prefix ever changes.
 */
export function isExecutionToolName(
  name: string,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): boolean {
  if (name === "run_workflow") return true;
  if (!name.startsWith(WORKFLOW_TOOL_PREFIX)) return false;
  return syntheticWorkflowSlugs.has(name.slice(WORKFLOW_TOOL_PREFIX.length));
}

/**
 * A slug is "nameable" — safe to match against incidental prose — only when it
 * cannot collide with a common word: multi-segment kebab slugs
 * (`notion-essay-to-markdown`) always qualify; single-token slugs must be long
 * enough (≥ MIN_SINGLE_TOKEN_SLUG_LENGTH) that a bare verb like `run`/`build`
 * can never self-match and spuriously expose execution.
 */
const MIN_SINGLE_TOKEN_SLUG_LENGTH = 6;

function isNameableSlug(slug: string): boolean {
  if (slug.length < 4) return false;
  if (slug.includes("-")) return true;
  return slug.length >= MIN_SINGLE_TOKEN_SLUG_LENGTH;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the first catalog slug that appears in `message` as a whole-word /
 * kebab token (case-insensitive), else null. Slugs come from the tenant's own
 * workflow catalog (trusted, kebab), but are still regex-escaped. The
 * `isNameableSlug` floor prevents a short common-word slug from self-matching
 * incidental prose.
 */
export function resolveNamedWorkflowSlug(
  message: string | null | undefined,
  slugCatalog: ReadonlySet<string>,
): string | null {
  if (!message) return null;
  for (const slug of slugCatalog) {
    if (!isNameableSlug(slug)) continue;
    // Boundaries reject identifier chars (incl. hyphen) on both sides so a
    // slug never matches inside a longer token.
    const re = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(slug.toLowerCase())}([^a-z0-9-]|$)`, "i");
    if (re.test(message)) return slug;
  }
  return null;
}

/**
 * Derive the bare saved-workflow slug catalog from a palette's tool names — the
 * synthetic `wf_<slug>` peers built this turn. Lets the loop reuse the palette
 * it already has instead of re-querying the workflow catalog.
 */
export function collectSyntheticWorkflowSlugs(toolNames: Iterable<string>): Set<string> {
  const slugs = new Set<string>();
  for (const name of toolNames) {
    if (name.startsWith(WORKFLOW_TOOL_PREFIX)) {
      slugs.add(name.slice(WORKFLOW_TOOL_PREFIX.length));
    }
  }
  return slugs;
}

/**
 * Apply the execution-tool gate to a per-turn palette: when execution is NOT
 * exposed, delete `run_workflow` and every synthetic `wf_<slug>` peer. Mutates
 * `tools` in place and returns the number of tools removed (for logging). The
 * loop and its tests both call this so the removal contract has a single home.
 *
 * NOTE: `dry_run_workflow` (the DRAFT runner) intentionally survives this gate —
 * `isExecutionToolName` matches only `run_workflow` / `wf_<slug>`. That is
 * deliberate: when the model reaches for a gated saved-workflow tool to TEST
 * its fresh draft, the repair handler (`llm/core/repair-tool-call.ts`) rewrites
 * the call to `dry_run_workflow`, so a draft-run target is always reachable
 * without ever running a saved lookalike.
 */
export function applyExecutionToolGate(
  tools: Record<string, unknown>,
  decision: ExecutionToolGateDecision,
  syntheticWorkflowSlugs: ReadonlySet<string>,
): number {
  if (decision.exposeExecution) return 0;
  let removed = 0;
  for (const name of Object.keys(tools)) {
    if (isExecutionToolName(name, syntheticWorkflowSlugs)) {
      delete tools[name];
      removed += 1;
    }
  }
  return removed;
}
