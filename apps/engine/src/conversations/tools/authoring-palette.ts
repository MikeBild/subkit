// Skill-gated tool palette.
//
// Replaces the old state-gated palette (PR10/PR15). The new design:
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
 */
const ALWAYS_AVAILABLE_CLEANUP: ReadonlySet<string> = new Set([
  "delete_connector",
  "delete_knowledge_source",
  "delete_subscription",
  "delete_tunnel",
  "delete_workflow",
  "revoke_api_key",
  "revoke_portal_token",
  "update_workflow",
  "update_connector",
  "update_knowledge_source",
  "update_subscription",
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

/** Workflow authoring tools — exposed once `workflow-authoring` is loaded. */
const WORKFLOW_AUTHORING: ReadonlySet<string> = new Set([
  "build_workflow",
  "connect_steps",
  "inspect_workflow_draft",
  "propose_step",
  "start_workflow_from_goal",
  "update_param",
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
const WORKFLOW_PERSISTENCE: ReadonlySet<string> = new Set(["commit_draft"]);

/** Execution + diagnosis — paired with workflow authoring. The tools
 *  themselves emit a `tool_unavailable_in_state` envelope when no
 *  workflow is yet persisted / no execution exists. */
const EXECUTION_TOOLS: ReadonlySet<string> = new Set(["run_workflow"]);
const DIAGNOSIS_TOOLS: ReadonlySet<string> = new Set(["diagnose_latest_execution"]);

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

  if (loadedSkills.has(CONNECTOR_AUTHORING_SKILL)) {
    addNames(allowed, CONNECTOR_AUTHORING);
    addNames(allowed, CONNECTOR_PERSISTENCE);
    addNames(allowed, CONNECTOR_OAUTH);
  }
  if (loadedSkills.has(WORKFLOW_AUTHORING_SKILL)) {
    addNames(allowed, WORKFLOW_AUTHORING);
    addNames(allowed, WORKFLOW_PREVIEW);
    addNames(allowed, WORKFLOW_PERSISTENCE);
    addNames(allowed, EXECUTION_TOOLS);
    addNames(allowed, DIAGNOSIS_TOOLS);
  }
  // tenant_read tools are tenant-scoped, side-effect-free, and parallelisable.
  // They should always be reachable so the LLM can introspect tenant state at
  // any point — listing workflows, fetching audit entries, checking engine
  // status, browsing knowledge sources. Filtering them by skill would create
  // dead-ends for ordinary "what's there?" turns.
  return tools.filter((tool) => allowed.has(tool.name) || tool.category === "tenant_read");
}
