// Tool palette registry.
//
// Every structured-intent tool is a small module with a zod input
// schema and an `execute(ctx, args)` method. The loop looks the tool
// up by name, validates the arguments, runs the tool, and feeds the
// result back to the model.

import type { z } from "@hono/zod-openapi";

import type { Db } from "../../db/client.ts";
import type { EngineClient } from "../../engine-client/index.ts";
import type { ElicitationBridge } from "../elicitation-bridge.ts";
import type { DraftDocument } from "../types.ts";
import { analyzeScrapeTargetTool } from "./analyze-scrape-target.ts";
import {
  askUserChoiceTool,
  askUserConfirmTool,
  askUserFormTool,
  askUserMultiTool,
  askUserTextTool,
} from "./ask-user/index.ts";
import { authenticateOAuthTool } from "./authenticate-oauth.ts";
import { authorWorkflowTool } from "./author-workflow.ts";
import { callConnectorTool } from "./call-connector.ts";
import { cannotHelpTool } from "./cannot-help.ts";
import { diagnoseLatestExecutionTool } from "./diagnose-latest-execution.ts";
import { discoverConnectorEndpointsTool } from "./discover-connector-endpoints.ts";
import { discoverSystemsFromFilesTool } from "./discover-systems-from-files.ts";
import { dryRunStepTool } from "./dry-run-step.ts";
import { dryRunTransformTool } from "./dry-run-transform.ts";
import { dryRunWorkflowTool } from "./dry-run-workflow.ts";
import { editRoleTool } from "./edit-role.ts";
import { editWorkflowPatchTool } from "./edit-workflow-patch.ts";
import { fetchConnectorDocsTool } from "./fetch-connector-docs.ts";
import { fetchConnectorSelfDescriptionTool } from "./fetch-connector-self-description.ts";
import { findConnectorTool } from "./find-connector.ts";
import { findRoleTool } from "./find-role.ts";
import { findSkillTool } from "./find-skill.ts";
import { findUserTool } from "./find-user.ts";
import { findWorkflowTool } from "./find-workflow.ts";
import { importConnectorFromSpecTool } from "./import-connector-from-spec.ts";
import { inspectAuthoringContextTool } from "./inspect-authoring-context.ts";
import { inspectConnectorDraftTool } from "./inspect-connector-draft.ts";
import { inspectRecipeTool } from "./inspect-recipe.ts";
import { inspectRoleTool } from "./inspect-role.ts";
import { inspectWorkflowTool } from "./inspect-workflow.ts";
import { inspectWorkflowDraftTool } from "./inspect-workflow-draft.ts";
import { listAttachmentsTool } from "./list-attachments.ts";
import { listCapabilityGapsTool } from "./list-capability-gaps.ts";
import { listSkillSuggestionsTool } from "./list-skill-suggestions.ts";
import { listSkillsTool } from "./list-skills.ts";
import { matchConnectorTemplateByUrlTool } from "./match-connector-template-by-url.ts";
import { previewAttachmentTool } from "./preview-attachment.ts";
import { probeConnectorTool } from "./probe-connector.ts";
import { probeConnectorDraftTool } from "./probe-connector-draft.ts";
import { proposeSchemaMigrationTool } from "./propose-schema-migration.ts";
import { proposeSkillTool } from "./propose-skill.ts";
import { requestConnectorReauthTool } from "./request-connector-reauth.ts";
import { saveConnectorDraftTool } from "./save-connector-draft.ts";
import { saveLearningTool } from "./save-learning.ts";
import { saveWorkflowDraftTool } from "./save-workflow-draft.ts";
import { searchDocsTool } from "./search-docs.ts";
import { searchKnowledgeTool } from "./search-knowledge.ts";
import { startConnectorFromDescriptionTool } from "./start-connector-from-description.ts";
import { startConnectorFromTemplateTool } from "./start-connector-from-template.ts";
import { startWorkflowFromRecipeTool } from "./start-workflow-from-recipe.ts";
import { suggestConnectorTemplatesTool } from "./suggest-connector-templates.ts";
import { suggestJsonataPathsTool } from "./suggest-jsonata-paths.ts";
import { testConnectorTool } from "./test-connector.ts";
import { updateConnectorDraftTool } from "./update-connector-draft.ts";
import { validateConnectorDraftTool } from "./validate-connector-draft.ts";
import { validateDraftTool } from "./validate-draft.ts";

/**
 * Tool execution context handed to every conversation tool. Carries the
 * tenant-scoped EngineClient so `tenant_read` / `tenant_write` tools can
 * introspect and mutate tenant state without reimplementing RBAC/audit.
 */
export interface ToolContext {
  /** Server-owned consumed decision. Never accepted from tool arguments. */
  direct_connector_approval?: import("../../tools/direct-connector-binding.ts").DirectConnectorApproval;
  db: Db;
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /**
   * Resolved principal for RBAC-checking tools that need finer-grained
   * permission evaluation than `tenant_id` + `actor_id` provide. Set
   * by `loop.ts` when the conversation turn is driven from an
   * authenticated HTTP/MCP request; absent on test harnesses and the
   * in-process MCP elicitation worker. Tools that read this MUST
   * guard against the undefined case.
   */
  principal?: import("../../auth/types.ts").ResolvedPrincipal | null;
  /** Current conversation_tool_calls.id for this tool execution. */
  tool_call_id?: string;
  /** Assistant message id anchoring this tool step's child rows. */
  assistant_message_id?: string | null;
  connector_id: string | null;
  workflow_id: string | null;
  engineClient: EngineClient;
  getDraft: () => DraftDocument;
  setDraft: (next: DraftDocument) => Promise<void>;
  /** Abort signal for the currently running conversation turn. */
  abortSignal?: AbortSignal;
  /**
   * Names of the tools actually exposed to the model this turn — the
   * resolved palette after the skill gate, the surface restriction, and
   * the synthetic/external additions, i.e. exactly the keys `wrapTools`
   * hands to the SDK.
   *
   * Threaded so a tool can check a claim the model makes ABOUT the
   * palette against the palette itself. `cannot_help` is the case that
   * needed it: it accepted `missing_capability: "tool.<name>"` verbatim,
   * so a model could abstain — and durably file a capability gap —
   * naming a tool it had already called successfully in the same turn.
   *
   * Optional on purpose: absent means "cannot verify", and an
   * unverifiable abstention must still be allowed through. Never use
   * this to widen what a tool may do; it answers one question, whether a
   * name was in the palette.
   */
  availableToolNames?: ReadonlySet<string>;
  /**
   * Optional live-log callback. Long-running tools (run_workflow,
   * dry_run_step, refresh_connector_docs) call this to emit progress
   * updates that surface as `tool_log` TurnEvents, rendered live by sk
   * Ink and streamed via HTTP SSE / MCP notifications. Short tools
   * leave it unused.
   */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /**
   * Permission mode the client advertised for this turn (auto / ask /
   * plan). Tools that stage confirmations (`ask_user_confirm`) can use
   * this to auto-resolve in `auto` mode without pausing the loop.
   */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /**
   * Surface this turn is running on — mirrors `RunLoopParams.surface`.
   * `"mcp"` is set ONLY by the backgrounded `conversation.run-turn`
   * worker (no live session, no `elicitationBridge`), so tools can treat
   * it as the "unattended, cannot surface a follow-up prompt" signal.
   * `undefined` on legacy/test harnesses that never set it.
   * `"chat"` (external chat platforms) additionally selects the
   * channel-scoped read-only palette in `sdk-wrap.ts`.
   */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  /**
   * Operator's most recent user message, raw text. Threaded so tools
   * can ground deterministic relevance scoring (e.g.
   * `discover_connector_endpoints` ranks suggested endpoints against
   * this string) without re-reading the conversation. `null` when the
   * turn was triggered without a fresh user message (e.g. a continuation
   * after an elicitation reply).
   */
  recentUserMessage?: string | null;
  /**
   * Optional diff emitter — tools that mutate the draft (`author_workflow`,
   * `edit_workflow_patch`, `save_connector_draft`) call
   * this with the canonical before/after JSON of the affected resource.
   * The conversation loop turns it into a `diff` TurnEvent the CLI
   * renders inline as a unified-diff cell — operators see exactly what
   * changed without scrolling back to the prior state.
   *
   * Best-effort: emitter errors never block the tool. Tools that pass
   * undefined skip the diff cell entirely.
   */
  emitDiff?: (params: {
    title: string;
    language: "json" | "yaml" | "text";
    before: string;
    after: string;
  }) => void;
  /**
   * MCP-native elicitation bridge. Present ONLY on the MCP surface and
   * Currently ALWAYS `undefined` — no surface constructs a concrete bridge
   * (MCP write approval is portal-only, and MCP conversation elicitation
   * uses the DB-pause path), so tools that collect user input (`ask_user_*`,
   * `authenticate_oauth`) probe `elicitationBridge?.capabilities`, find
   * none, and take the DB-pause / `respondElicitation` round-trip. The
   * contract lives in `conversations/elicitation-bridge.ts` for a future
   * in-process surface.
   */
  elicitationBridge?: ElicitationBridge;
}

/** Elicitation pause descriptor shared by both ToolResult branches. */
export interface ToolResultPause {
  /** Which `ask_user_*` tool paused the loop. */
  tool_name:
    "ask_user_choice" | "ask_user_multi" | "ask_user_text" | "ask_user_form" | "ask_user_confirm";
  /**
   * Optional `kind` hint for `ask_user_confirm` — lets the client
   * pick the right sub-renderer (structured diff for
   * `save_workflow_draft`, target URL + payload for `external_write`,
   * generic JSON otherwise).
   */
  kind?: "save_workflow_draft" | "external_write" | "generic";
  summary: string;
  /** Row id in `conversation_elicitations`. */
  elicitation_id: string;
  /**
   * Full tool input payload — options/fields/question/diff/target.
   * Surfaced verbatim on the `elicit_request` SSE frame so the CLI
   * has everything needed to render the right prompt without a
   * second fetch.
   */
  input?: unknown;
  /** Structured payload surfaced to the client. */
  diff?: unknown;
  /** Free-form target descriptor (url, workflow path, etc). */
  target?: unknown;
}

/**
 * Discriminated union returned by every conversation tool.
 *
 * `ok: true`  — tool succeeded; `data` carries the payload.
 * `ok: false` — tool failed; callers may use the legacy `data` field
 *   OR the structured error fields (`error_code`, `message`, `details`,
 *   `next_best_actions`). Prefer the structured form for new rejections
 *   so the loop can fold `next_best_actions` into the next turn's
 *   `prior_failures`.
 */
export type ToolResult =
  | {
      ok: true;
      /** Data echoed back to the loop and fed to the model as a tool-result message. */
      data: unknown;
      /** When set, the driver pauses the loop on a pending elicitation. */
      pause?: ToolResultPause;
      /** When set, this tool call created or updated a persisted workflow version. */
      committed_workflow_id?: string;
    }
  | {
      ok: false;
      /** Legacy payload field — present on most existing `ok: false` results. */
      data?: unknown;
      /** Machine-readable rejection code. */
      error_code?: string;
      /** Human-readable rejection message surfaced to the model and operator. */
      message?: string;
      /** Additional structured context for the rejection. */
      details?: unknown;
      /**
       * Ordered list of tool names the model should consider next.
       * The loop folds these into the next turn's `prior_failures`
       * automatically.
       */
      next_best_actions?: string[];
      /** When set, the driver pauses the loop on a pending elicitation. */
      pause?: ToolResultPause;
      /** When set, this tool call created or updated a persisted workflow version. */
      committed_workflow_id?: string;
    };

/**
 * Tool category — controls parallel-read mutex and surfaces filtering.
 *   - `draft_write`: mutates the conversation's working draft (serialised).
 *   - `tenant_read`: reads tenant state via EngineClient (parallelisable).
 *   - `tenant_write`: mutates tenant state (serialised + confirmation).
 */
export type ToolCategory = "draft_write" | "tenant_read" | "tenant_write";

export interface ConversationTool {
  readonly name: string;
  readonly description: string;
  // No `outputSchema` field by design. Tools return an ok/data envelope the
  // LLM reads as free-form context, not a strict wire contract — so blanket
  // per-tool output validation across ~60 tools would buy near-zero safety
  // while adding constant Zod-drift and maintenance. The one place a strict
  // output shape genuinely matters — the recorded-eval evidence — is already
  // Zod-validated at its own boundary (see conversations/recorded-eval.ts).
  // Keep output validation targeted there; do not generalise it here.
  readonly inputSchema: z.ZodTypeAny;
  readonly category: ToolCategory;
  // Keeps connector and workflow state machines disjoint during authoring.
  readonly authoring_resource?: "connector" | "workflow";
  /**
   * `args` is untrusted at the type level. The dispatcher (`tools/dispatcher.ts`
   * canonicalizeArgs) and the chat loop's AI SDK boundary both hand over
   * `inputSchema`'s OUTPUT; direct callers (`conversations/direct-invoke.ts`,
   * the connector import route) hand over raw input, so an executor that needs
   * defaults still parses. Because `tools/approval.ts` persists the canonical
   * value and the approved replay re-enters the executor, that second parse is
   * only safe while every `inputSchema` is parse-idempotent — enforced for the
   * whole registry by `tools/schema-idempotence.test.ts`. Never add a schema
   * transform without a fixture there. Declared `unknown` because the registry
   * is heterogeneous; each tool narrows it to its own `z.infer`.
   */
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  /** One-sentence hint: when should the LLM reach for this tool? Rendered
   *  into the tool description as a `<use_case>` block so the model can
   *  discriminate it from siblings without exhaustive trial-and-error. */
  readonly use_case?: string;
  /** Bullet list of caveats the LLM should read before invoking — limits,
   *  side effects, failure modes. Rendered as `<important_notes>`. */
  readonly important_notes?: readonly string[];
  /** Slug of a skill that must be loaded before this tool becomes visible.
   *  Advisory mirror of the authoritative `skills.gates_tools` map — used
   *  by the description compiler to tell the model up front what skill to
   *  load. Not enforced by this field alone. */
  readonly requires_skill?: string;
  /** tenant_write only: keep this tool callable on the read-only MCP
   *  surface, which otherwise hides every tenant_write. Set it ONLY when
   *  the definition site states why the write is safe there (a run rather
   *  than a config mutation, or an inert/self-gated capture-loop write) —
   *  the provider filter reads this flag instead of a hand-curated name
   *  set, so the exemption and its rationale live on the tool itself. */
  readonly visible_when_readonly?: boolean;
  /** The mirror of `visible_when_readonly`, for reads: this tool is a step of
   *  BUILDING a definition, not of using one, so it belongs to the authoring
   *  tiers even though its category is `tenant_read`.
   *
   *  Reading and running are what a plain credential is for; discovering an
   *  API's endpoints, dry-running a transform, probing a connector or asking
   *  for a schema migration are authoring moves that happen to read. Category
   *  cannot tell them apart — `call_connector` and `list_workflows` are both
   *  `tenant_read` — so the distinction is declared here, next to the tool,
   *  rather than in a name list somewhere else that nobody updates.
   *
   *  Set it on any new tool whose purpose is to help compose a connector,
   *  workflow, knowledge source or skill. The per-mode catalogue snapshot
   *  (`mcp/tests/tools-list-catalog-snapshot.test.ts`) pins the exact result,
   *  so a forgotten flag shows up as a failing diff rather than as a tool
   *  quietly reachable from a credential that was never granted authoring. */
  readonly authoring_only?: boolean;
  /** A realistic example argument object. Rendered as `<example>` and
   *  parsed by some clients (MCP) to prefill inputs. */
  readonly example_input?: Readonly<Record<string, unknown>>;
  /** Enable provider-native strict mode. Anthropic JSON-mode
   *  and OpenAI structured outputs enforce the input schema server-side,
   *  drastically reducing malformed tool calls and `repairToolCall`
   *  roundtrips. Opt-in per tool because strict mode imposes JSON-Schema
   *  draft-07 limits (no anyOf with unrestricted properties, etc.) that
   *  not every input schema satisfies. */
  readonly strict?: boolean;
  /**
   * True when this tool's contract requires a workflow row to already
   * exist in `workflows` (referenced by id, by an active target with
   * `lifecycle_state: "persisted"`, or by a `workflow_id` on a related
   * row like a schedule). Tools that take a `workflow_id` UUID of a
   * persisted row — `run_workflow`, `update_workflow`, `delete_workflow`,
   * `create_schedule`, `update_schedule`, `delete_schedule` — cannot
   * succeed before the first `save_workflow_draft` lands.
   *
   * The step-router uses this flag in `activeToolsForStage` to drop
   * these tools from the LLM's palette on every pre-persistence
   * authoring stage (`workflow_draft_started`, `workflow_validated`,
   * `workflow_previewed`). Removing them from the palette prevents the
   * LLM from picking `run_workflow` over `author_workflow` /
   * `edit_workflow_patch` / `save_workflow_draft` on the first authoring
   * step — the loop-detected production failure where the model called
   * `run_workflow` repeatedly against a workflow that had not been saved.
   *
   * The forced-tool invariant still wins: a turn-level
   * `toolChoice: { type: "tool", toolName: "run_workflow" }` re-adds the
   * tool to the narrowed palette so the AI SDK's per-step validation
   * doesn't throw `Tool '<name>' not found in provided tools`. The two
   * invariants coexist deliberately: this flag governs the *default*
   * authoring palette; the operator-requested forced-tool path is an
   * explicit override.
   */
  readonly requires_persisted_workflow?: boolean;
  /**
   * True when this tool reads (or mutates) the conversation's working
   * draft — i.e. it only makes sense inside a live authoring conversation
   * whose `ctx.getDraft()` returns real state. The MCP stub context
   * (`mcp/adapter.ts#buildMcpStubCtx`) supplies an EMPTY draft with no-op
   * `getDraft`/`setDraft`, so dispatching one of these tools on the direct
   * MCP `tenant_*` path would silently operate on nothing and return a
   * misleading success. The dispatcher reads this flag and short-circuits
   * such a call to `not_available_on_surface` (pointing the caller at
   * `conversation_start`) instead of the silent empty-draft no-op.
   *
   * This is orthogonal to `category: "draft_write"` (which governs write
   * POLICY): a `tenant_read`/`tenant_write` tool can still be draft-DEPENDENT
   * for its DATA. Marking it here is the declarative capability the guard
   * keys on — no per-tool name list in the dispatcher.
   */
  readonly requires_draft?: boolean;
  /**
   * Declarative RBAC gate, enforced centrally in `wrapOne` BEFORE the tool's
   * `execute` runs. Replaces the per-tool `resolveConversationPrincipal(ctx) +
   * can(...)` boilerplate every write tool hand-rolled. When present, the
   * wrapper resolves the conversation principal and calls `can()`; a deny
   * writes a `policy.denied` audit row and returns a `permission_denied`
   * envelope, and the tool never executes. A null principal
   * (system/unauthenticated) is allowed, matching the inline helpers.
   *
   * Resource id resolution precedence:
   *   1. `resolveResourceId(ctx, rawArgs)` when present — for tools whose id is
   *      NOT a raw arg (slug→UUID, id-or-slug, two-phase). Returning `null`
   *      DEFERS to the tool (e.g. slug not found) so it can emit its own
   *      not_found rather than a confusing permission_denied. Gating must use
   *      the resolved UUID: `can()` matches resource grants by exact id, so a
   *      slug would produce a wrong decision.
   *   2. else `rawArgs[resourceIdArg]` — the simple direct-arg case.
   *   3. else `"*"` — create-style tools that gate on the type only.
   *
   * `denyResult` lets a tool keep its own error-envelope contract (e.g.
   * `call_connector`'s nested `{error:{code,message}}` or the top-level
   * `error_code/message` form); omit it for the canonical
   * `{ ok:false, data:{ error:"permission_denied", permission, reason } }`.
   *
   * Business-logic gates conditional on args (self-vs-other reads) must stay
   * inline — this is for blanket gates only.
   */
  readonly permission?: {
    readonly action: string;
    readonly resourceType: string;
    readonly resourceIdArg?: string;
    readonly resolveResourceId?: (
      ctx: ToolContext,
      rawArgs: Record<string, unknown>,
    ) => Promise<string | null>;
    readonly denyResult?: (permission: string, reason: string) => ToolResult;
  };
}

const registry: Map<string, ConversationTool> = new Map();

import { sealSchema } from "./seal-schema.ts";

function register(tool: ConversationTool): void {
  // sealSchema tightens every conversation-tool input schema to
  // `.strict()` so the LLM cannot emit a tool call with fields the
  // schema does not permit. ZodObject inputs become strict; non-object
  // inputs pass through unchanged. Per-tool .execute(...) re-uses the
  // schema attached here, so the strictness propagates downstream.
  const sealed: ConversationTool = {
    ...tool,
    inputSchema: sealSchema(tool.inputSchema),
  };
  registry.set(sealed.name, sealed);
}

register(listSkillsTool);
register(fetchConnectorDocsTool);
register(fetchConnectorSelfDescriptionTool);
register(inspectAuthoringContextTool);
register(inspectConnectorDraftTool);
register(inspectWorkflowDraftTool);
register(inspectWorkflowTool);
register(searchKnowledgeTool);
register(saveLearningTool);
register(searchDocsTool);
register(analyzeScrapeTargetTool);
register(listSkillSuggestionsTool);
register(listCapabilityGapsTool);
register(listAttachmentsTool);
register(previewAttachmentTool);
register(probeConnectorTool);
register(probeConnectorDraftTool);
register(testConnectorTool);
register(callConnectorTool);
register(authorWorkflowTool);
register(proposeSkillTool);
register(saveConnectorDraftTool);
register(authenticateOAuthTool);
register(startConnectorFromDescriptionTool);
register(startConnectorFromTemplateTool);
register(startWorkflowFromRecipeTool);
register(inspectRecipeTool);
register(suggestConnectorTemplatesTool);
register(suggestJsonataPathsTool);
register(findWorkflowTool);
register(findConnectorTool);
register(requestConnectorReauthTool);
register(findSkillTool);
register(findRoleTool);
register(findUserTool);
register(inspectRoleTool);
register(editRoleTool);
register(matchConnectorTemplateByUrlTool);
register(importConnectorFromSpecTool);
register(editWorkflowPatchTool);
register(proposeSchemaMigrationTool);
register(updateConnectorDraftTool);
register(diagnoseLatestExecutionTool);
register(discoverConnectorEndpointsTool);
register(discoverSystemsFromFilesTool);
register(dryRunStepTool);
register(dryRunTransformTool);
register(dryRunWorkflowTool);
register(validateDraftTool);
register(validateConnectorDraftTool);
register(saveWorkflowDraftTool);
register(askUserChoiceTool);
register(askUserMultiTool);
register(askUserTextTool);
register(askUserFormTool);
register(askUserConfirmTool);
register(cannotHelpTool);

// load_skill — on-demand skill injection, unlocking gated tools.
import { loadSkillTool } from "./load-skill.ts";

register(loadSkillTool);

// get_raw_result — fetch untruncated payload of a prior tool call.
import { getRawResultTool } from "./get-raw-result.ts";

register(getRawResultTool);

// inspect_execution_step — read persisted output of a single step
// from a completed execution. Closes the blind-authoring gap that
// produced session 3f6082d2's "format_output silently dropped fields"
// failure: now the LLM can read the actual loop body shape after a
// run instead of guessing JSONata paths.
import { inspectExecutionStepTool } from "./inspect-execution-step.ts";

register(inspectExecutionStepTool);

// inspect_execution — whole-execution step-level diagnosis. The
// surface-agnostic tenant_read sibling of inspect_execution_step: runs on
// chat and MCP alike, where the draft_write diagnose_latest_execution
// cannot.
import { inspectExecutionTool } from "./inspect-execution.ts";

register(inspectExecutionTool);

// test_rbac_expression — conversational RBAC probe.
import { testRbacExpressionTool } from "./test-rbac-expression.ts";

register(testRbacExpressionTool);

// get_vendor_recipe — canonical MCP-client config lookup (reads from
// the hand-curated VendorRecipeManifest at seed/vendor-recipes/).
// Delegating client specifics to this tool keeps the skill roster
// generic and lets new clients ship as a single JSON file, not a new
// prompt.
import { getVendorRecipeTool } from "./get-vendor-recipe.ts";

register(getVendorRecipeTool);

// Draft-snapshot rollback tools — paired with the auto-snapshot side
// effect in `sdk-wrap.ts`. Snapshots are LRU-capped at 10 per
// conversation; the LLM lists them, then restores the chosen one.
import { listDraftSnapshotsTool } from "./list-draft-snapshots.ts";
import { restoreDraftSnapshotTool } from "./restore-draft-snapshot.ts";
import { restoreWorkflowVersionTool } from "./restore-workflow-version.ts";

register(listDraftSnapshotsTool);
register(restoreDraftSnapshotTool);
register(restoreWorkflowVersionTool);

// Auto-generated read tools covering every read-surface domain:
// workflows, connectors, executions, skills, skill-candidates,
// patch-candidates, knowledge-sources, audit, metrics, identity
// (whoami + users + api-keys + portal-tokens + system-accounts),
// rbac (roles + permissions), hooks, subscriptions, status.
import { ALL_GENERATED_READ_TOOLS } from "./generated/index.ts";
import { ALL_GENERATED_WRITE_TOOLS } from "./generated/writes/index.ts";

for (const t of ALL_GENERATED_READ_TOOLS) register(t);
for (const t of ALL_GENERATED_WRITE_TOOLS) register(t);

export function getTool(name: string): ConversationTool | undefined {
  return registry.get(name);
}

export function listTools(): ConversationTool[] {
  return [...registry.values()];
}
