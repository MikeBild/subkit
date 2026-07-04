// step-router — prepareStep decisions for the converse loop.
//
// Default decision: pass through. Keep the model the loop already
// resolved, keep the full tool palette, do not touch system or
// providerOptions. The router only ever *upgrades* (escalates to a
// stronger model class, enables extended thinking) when a hard-step
// signal fires; it never downgrades.
//
// Wired into `streamText({ prepareStep })` in conversations/loop.ts.

import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";
import type { ConversationTool } from "../../conversations/tools/index.ts";
import type { AuthoringStage } from "../../conversations/types.ts";
import { logger } from "../../logging/logger.ts";
import type { LlmProviderKind } from "../types.ts";
import { resolveThinking } from "./thinking-policy.ts";

// One-shot warning per provider — keeps logs clean when a tenant is
// pinned to a provider whose ladder has no upgrade for the configured
// model.
const NO_UPGRADE_WARNED: Set<string> = new Set();

/** Signals the loop computes per turn and threads into every prepareStep call. */
export interface StepRouterSignals {
  /** Active authoring stage (idle / discover / propose / commit / execute / etc). */
  stage?: AuthoringStage;
  /**
   * True when the conversation has a PERSISTED workflow bound — either
   * the bound `target_workflow_id` resolves to a `workflows` row, or
   * `draft.summary.active_target.kind === "workflow"` with
   * `lifecycle_state === "persisted"`, or
   * `draft.summary.persisted_resources` includes a `workflow`.
   *
   * Gates the `requires_persisted_workflow` drop pass in
   * `activeToolsForStage`. The stage alone is not enough — the
   * production-observed bug fires at `stage = idle` (first turn of
   * `conversation_start("build a workflow ...")`) where the LLM
   * repeatedly picks `run_workflow{}` because the palette still shows
   * it. Whenever this is false, every tool flagged
   * `requires_persisted_workflow` is dropped from the activeTools set,
   * regardless of stage. The post-persistence stages
   * (`workflow_persisted`, `workflow_executed`) still return the full
   * palette anyway because this signal is true by definition there.
   */
  hasPersistedWorkflow?: boolean;
  /** Set by the loop after a tool-call repair fired in the prior step. */
  hadRepairThisTurn?: boolean;
  /**
   * G7 (runtime-logs review plan): which tool's repair triggered the
   * upgrade. Lets post-hoc auditing answer "WHY did this turn run on
   * Sonnet?" without bisecting the journal — the operator reads the
   * tool name straight off the `step_router.model_swapped` log line.
   * Optional because not every turn has a repair, and the prior-step
   * read happens after the upgrade has already been decided.
   */
  repairAttribution?: { tool: string; error_kind?: string | undefined };
  /** Set when the intent detector flagged a strong run-intent verb. */
  strongRunIntent?: boolean;
  /**
   * Set when the user's current message explicitly requested BOTH a
   * connector AND a workflow ("create a connector and a workflow ...").
   * Used by the router to force tool-calling on the step right after a
   * successful save_connector_draft auto-persist, so the model proceeds
   * to the workflow instead of stopping on a "now let's build the
   * workflow" closing sentence.
   */
  multiArtifactIntent?: boolean;
  /** Set after a critic verdict: "fail" earlier in this conversation. */
  priorCriticFail?: boolean;
  /** Manual one-tier-up bump from caller. */
  escalate?: boolean;
  /** Manual jump-to-top-tier from caller. */
  escalateMax?: boolean;
}

export interface StepRouterParams {
  stepNumber: number;
  steps: ReadonlyArray<unknown>;
  messages: ReadonlyArray<ModelMessage>;
  /** The model the loop already resolved (tenant default). */
  model: LanguageModel;
  /** Tenant default model id (string). Used to compute escalation targets. */
  tenantDefaultModelId: string;
  /** Provider currently in use. Drives the per-provider upgrade ladder. */
  provider: LlmProviderKind;
  /** Available tools, keyed by name. Used for activeTools narrowing. */
  toolsByName: Record<string, ConversationTool>;
  signals: StepRouterSignals;
  /**
   * True when the loop has enabled `providerOptions.anthropic.thinking`
   * for this entire turn. Anthropic rejects `tool_choice: { type: "tool" }`
   * and `tool_choice: "any"`/`"required"` with thinking enabled, so this
   * router must NOT set `toolChoice: "required"` when this is true —
   * even if it would otherwise (multi-artifact continuation). Surfaces
   * the constraint that `loop.ts` already enforces at the call-site for
   * the `preferredTool` path.
   */
  turnThinkingEnabled?: boolean;
  /**
   * The turn-level forced tool, when `loop.ts` set
   * `toolChoice: { type: "tool", toolName }` for the whole streamText
   * invocation. The AI SDK validates the forced tool name against the
   * step's `activeTools` set on EVERY step — if `activeToolsForStage`
   * narrowing drops it (e.g. `run_workflow`, a `tenant_write` tool, on
   * the `workflow_previewed` stage), the SDK throws
   * `Tool '<name>' not found in provided tools` and the turn fails.
   * The router must therefore always re-add this tool to any narrowed
   * `activeTools` set. The tool stays policy-gated downstream — being
   * visible to the model is not the same as bypassing confirmation.
   */
  forcedTool?: string | null;
}

/**
 * Decision returned to the AI SDK's `prepareStep`. Every field is
 * optional; omitted fields mean "use what the loop already configured".
 *
 * Extended thinking is deliberately NOT a field here — AI SDK 6.x
 * applies `providerOptions` at streamText construction and there is
 * no per-step override. The loop checks `supportsExtendedThinking`
 * directly when computing turn-level providerOptions.
 */
export interface StepDecision {
  /** When set, the per-step model id the loop should resolve and pass to streamText. */
  modelId?: string;
  toolChoice?: ToolChoice<ToolSet>;
  activeTools?: string[];
  system?: string;
  /** Internal reason — surfaces in telemetry. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Per-provider upgrade ladder.
//
// Maps a model id to the next-tier-up id for the same provider. Only
// upward edges are listed — by construction, `routeUp(top)` is the
// identity. Providers without a sensibly stronger tier silently no-op
// the upgrade.
// ---------------------------------------------------------------------------

interface UpgradeLadder {
  /** Bare model id → next-tier-up id (one step). */
  oneUp: Record<string, string>;
  /** Bare model id → top-tier id (terminal). */
  top: Record<string, string>;
}

// `bareModelId` strips date suffixes, so each ladder entry is keyed
// on the canonical base id. `claude-haiku-4-5-20251001` and
// `gpt-4o-2024-11-20` collapse to their base equivalents before lookup.
// `claude-opus-4-8` is the top of the Anthropic ladder. The `oneUp`
// edge `claude-opus-4-7 → claude-opus-4-8` is what makes a hard-turn
// escalation from the authoring seed (which runs on opus-4-7's
// successor opus-4-8) a real upgrade instead of the dead 4-7→4-7
// identity that logged `step_router.no_upgrade_available` on every
// authoring turn. `top` jumps straight to opus-4-8 from any tier.
const ANTHROPIC_LADDER: UpgradeLadder = {
  oneUp: {
    "claude-3-5-haiku": "claude-3-5-sonnet",
    "claude-3-5-sonnet": "claude-3-opus",
    "claude-3-opus": "claude-opus-4-7",
    "claude-haiku-4-5": "claude-sonnet-4-5",
    "claude-sonnet-4-5": "claude-opus-4-7",
    "claude-sonnet-4-6": "claude-opus-4-7",
    "claude-opus-4-6": "claude-opus-4-7",
    "claude-opus-4-7": "claude-opus-4-8",
  },
  top: {
    "claude-3-5-haiku": "claude-opus-4-8",
    "claude-3-5-sonnet": "claude-opus-4-8",
    "claude-3-opus": "claude-opus-4-8",
    "claude-haiku-4-5": "claude-opus-4-8",
    "claude-sonnet-4-5": "claude-opus-4-8",
    "claude-sonnet-4-6": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-8",
    "claude-opus-4-7": "claude-opus-4-8",
  },
};

const OPENAI_LADDER: UpgradeLadder = {
  oneUp: {
    "gpt-4o-mini": "gpt-4o",
    "gpt-4o": "gpt-4.1",
    "gpt-4-turbo": "gpt-4o",
    "o1-mini": "o1-preview",
  },
  top: {
    "gpt-4o-mini": "gpt-4.1",
    "gpt-4o": "gpt-4.1",
    "gpt-4-turbo": "gpt-4.1",
    "gpt-4.1": "gpt-4.1",
    "o1-mini": "o1-preview",
    "o1-preview": "o1-preview",
  },
};

const GEMINI_LADDER: UpgradeLadder = {
  oneUp: {
    "gemini-1.5-flash": "gemini-1.5-pro",
    "gemini-2.0-flash": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-pro",
  },
  top: {
    "gemini-1.5-flash": "gemini-2.5-pro",
    "gemini-1.5-pro": "gemini-2.5-pro",
    "gemini-2.0-flash": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-pro",
    "gemini-2.5-pro": "gemini-2.5-pro",
  },
};

const LADDERS: Partial<Record<LlmProviderKind, UpgradeLadder>> = {
  anthropic: ANTHROPIC_LADDER,
  bedrock: ANTHROPIC_LADDER,
  vertex: ANTHROPIC_LADDER,
  gateway: ANTHROPIC_LADDER,
  openai: OPENAI_LADDER,
  azure: OPENAI_LADDER,
  gemini: GEMINI_LADDER,
};

function bareModelId(modelId: string): string {
  // Strip provider prefixes (`anthropic/claude-…`).
  const noProvider = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  // Strip vendor-stamped date suffixes so `gpt-4o-2024-11-20` and
  // `claude-haiku-4-5-20251001` collapse to their base ids in the
  // ladder lookup. The pattern matches a trailing `-YYYYMMDD` (8
  // contiguous digits) or `-YYYY-MM-DD`.
  return noProvider.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

/** Returns the next-tier-up model id for `modelId` on `provider`, or `modelId` if no upgrade exists. */
export function routeUp(provider: LlmProviderKind, modelId: string): string {
  const ladder = LADDERS[provider];
  if (!ladder) {
    warnOnceNoUpgrade(provider, modelId, "no_ladder_for_provider");
    return modelId;
  }
  const bare = bareModelId(modelId);
  const upgraded = ladder.oneUp[bare];
  if (upgraded === undefined) {
    warnOnceNoUpgrade(provider, modelId, "no_upgrade_in_ladder");
    return modelId;
  }
  return upgraded;
}

/** Returns the top-tier model id for `provider`, or `modelId` if no top is known. */
export function routeTop(provider: LlmProviderKind, modelId: string): string {
  const ladder = LADDERS[provider];
  if (!ladder) return modelId;
  const bare = bareModelId(modelId);
  return ladder.top[bare] ?? modelId;
}

function warnOnceNoUpgrade(provider: LlmProviderKind, modelId: string, reason: string): void {
  const key = `${provider}::${bareModelId(modelId)}::${reason}`;
  if (NO_UPGRADE_WARNED.has(key)) return;
  NO_UPGRADE_WARNED.add(key);
  logger.warn({
    module: "llm",
    action: "step_router.no_upgrade_available",
    msg: "no upgrade tier available for this provider+model — escalation will be a no-op",
    provider,
    model: modelId,
    reason,
  });
}

/** True when extended thinking is supported on this model id. */
export function supportsExtendedThinking(provider: LlmProviderKind, modelId: string): boolean {
  if (
    provider !== "anthropic" &&
    provider !== "bedrock" &&
    provider !== "vertex" &&
    provider !== "gateway"
  )
    return false;
  const bare = bareModelId(modelId);
  // Sonnet 4.5+, Opus 4.6+ support extended thinking. Haiku does not.
  return /^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7|opus-4-8)/.test(bare);
}

// ---------------------------------------------------------------------------
// activeTools — phase narrowing.
//
// Selects the subset of tool names the model may emit this step, based
// on the active authoring stage. Returning `undefined` means "use the
// full palette" (the SDK default).
// ---------------------------------------------------------------------------

const ALWAYS_AVAILABLE: ReadonlySet<string> = new Set([
  "ask_user_choice",
  "ask_user_multi",
  "ask_user_text",
  "ask_user_form",
  "ask_user_confirm",
  "cannot_help",
  "load_skill",
  "list_skills",
  "list_skill_suggestions",
  "search_knowledge",
  "search_docs",
  "fetch_connector_docs",
  "get_raw_result",
  "inspect_authoring_context",
]);

/**
 * Drop `requires_persisted_workflow` tools whenever the conversation
 * has no persisted workflow bound. Gating on `hasPersistedWorkflow`
 * (live draft state) rather than `stage` alone closes the
 * production-observed bug at `stage = idle`: the first turn of
 * `conversation_start("build a workflow ...")` runs with no draft yet,
 * the full palette includes `run_workflow{}`, and the LLM repeatedly
 * fires it until `tool.loop_detected`. The pre-persistence workflow
 * stages (`workflow_draft_started`, `workflow_inspected`,
 * `workflow_validated`, `workflow_previewed`) and `connector_persisted`
 * with no workflow bound exhibit the same failure mode.
 *
 * The flag belongs on tools the model auto-fires while authoring a
 * not-yet-persisted workflow: `run_workflow` (the original `run_workflow{}`
 * loop) and the schedule writes that bind the draft (`create_schedule` /
 * `update_schedule` / `delete_schedule`). It deliberately does NOT belong on
 * `delete_workflow` / `update_workflow` — those resolve an EXISTING workflow
 * by an explicit id/slug against the live table, are only called on explicit
 * management intent, and have no no-args loop. Flagging them hid the only verb
 * for "delete/rename workflow X" on a fresh conversation, so the model fell
 * back to `delete_connector`. See cleanup.ts / update-workflow.ts.
 */
function activeToolsForStage(
  stage: AuthoringStage | undefined,
  toolsByName: Record<string, ConversationTool>,
  forcedTool: string | null | undefined,
  hasPersistedWorkflow: boolean,
): string[] | undefined {
  const names = Object.keys(toolsByName);
  // True whenever no persisted workflow is bound on the conversation —
  // tools flagged `requires_persisted_workflow` must be dropped from
  // the palette regardless of stage. The forced-tool invariant (below)
  // still re-adds a turn-level forced tool by name so the AI SDK never
  // throws `Tool not found in provided tools`.
  const dropPersistedRequired = !hasPersistedWorkflow;
  const keep = (predicate: (t: ConversationTool) => boolean): string[] => {
    const kept = names.filter((n) => {
      // Forced-tool invariant: the turn-level
      // `toolChoice: { type: "tool", toolName }` is validated against
      // every step's activeTools by the AI SDK. If the operator
      // explicitly forced `run_workflow` we must keep it in the
      // palette — that path is the explicit-override branch and
      // policy still gates execution downstream. Document the
      // coexistence with the `requires_persisted_workflow` drop
      // below: the drop governs the *default* authoring palette; the
      // forced path is an *explicit* override.
      if (forcedTool && n === forcedTool) return true;
      if (ALWAYS_AVAILABLE.has(n)) {
        // ALWAYS_AVAILABLE has no tools flagged
        // `requires_persisted_workflow` today; the explicit
        // member-check protects against a future entry slipping in.
        const t = toolsByName[n];
        if (dropPersistedRequired && t?.requires_persisted_workflow === true) return false;
        return true;
      }
      const t = toolsByName[n];
      if (!t) return false;
      // Drop tools that contractually need a persisted workflow id
      // when none is bound. Survives only when the operator
      // explicitly forces one (handled above).
      if (dropPersistedRequired && t.requires_persisted_workflow === true) return false;
      return predicate(t);
    });
    return kept;
  };

  // When no persisted workflow is bound yet, every stage where the
  // model might otherwise see the full palette (idle, repairing,
  // connector_persisted) still needs the `requires_persisted_workflow`
  // drop applied. We compute the narrowed list inline and return it.
  const fullPaletteWithDrop = (): string[] | undefined => {
    if (!dropPersistedRequired) return undefined;
    return keep(() => true);
  };

  if (!stage || stage === "idle") {
    // No active draft — full palette unless the persisted-workflow gate
    // narrows it. The fix here is the structural close on the original
    // production failure mode (first-turn `build a workflow`).
    return fullPaletteWithDrop();
  }
  switch (stage) {
    case "connector_targeted":
    case "workflow_targeted":
    case "diagnosing":
      // Discover phase — favour reads.
      return keep((t) => t.category === "tenant_read");
    case "connector_draft_started":
    case "connector_inspected":
    case "connector_validated":
    case "connector_authenticated":
    case "connector_probed":
    case "workflow_draft_started":
    case "workflow_inspected":
    case "workflow_validated":
    case "workflow_previewed":
      // Propose / refine phase — draft writes + reads.
      // The `requires_persisted_workflow` drop above runs here too via
      // the `keep` helper whenever no persisted workflow is bound.
      return keep((t) => t.category === "tenant_read" || t.category === "draft_write");
    case "repairing":
      // Repair phase — same as propose but `tenant_write` is also
      // available so a successful repair can land its `save_workflow_draft` /
      // `save_connector_draft` without a forced stage transition.
      return fullPaletteWithDrop();
    case "connector_persisted":
      // A connector was just saved. If there is NO persisted workflow
      // yet, this turn is structurally pre-workflow and must drop
      // `requires_persisted_workflow` tools so `run_workflow{}` cannot
      // be picked. If a persisted workflow is bound (rare on this
      // stage but possible across multi-artifact conversations), the
      // full palette returns.
      return fullPaletteWithDrop();
    case "workflow_persisted":
    case "workflow_executed":
      // Commit / execute phase — full palette (tenant_write becomes
      // relevant). By definition a workflow row exists at this point,
      // so `requires_persisted_workflow` tools are valid.
      return undefined;
    default: {
      // Exhaustive guard — TypeScript will flag this if a new stage
      // is added to AuthoringStage without updating the switch.
      const _exhaustive: never = stage;
      void _exhaustive;
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// prepareStep — entry point.
// ---------------------------------------------------------------------------

/**
 * Compute the per-step decision. Returns `undefined` to mean "no
 * override" (the loop's existing config wins). The router never
 * downgrades the tenant's configured model.
 */
export function prepareStep(params: StepRouterParams): StepDecision | undefined {
  const { signals, provider, tenantDefaultModelId, toolsByName } = params;

  // ---- Escalation ladder ------------------------------------------------
  let modelId: string | undefined;
  const reasonParts: string[] = [];

  if (signals.escalateMax === true || signals.priorCriticFail === true) {
    const top = routeTop(provider, tenantDefaultModelId);
    if (top !== tenantDefaultModelId) {
      modelId = top;
      reasonParts.push(signals.priorCriticFail ? "prior_critic_fail" : "escalate_max");
    }
  } else if (
    signals.escalate === true ||
    signals.hadRepairThisTurn === true ||
    signals.strongRunIntent === true ||
    isHardStage(signals.stage)
  ) {
    const next = routeUp(provider, tenantDefaultModelId);
    if (next !== tenantDefaultModelId) {
      modelId = next;
      if (signals.hadRepairThisTurn) reasonParts.push("repair_in_prior_step");
      if (signals.strongRunIntent) reasonParts.push("strong_run_intent");
      if (signals.escalate) reasonParts.push("escalate_signal");
      if (isHardStage(signals.stage)) reasonParts.push(`hard_stage:${signals.stage}`);
    }
  }

  // ---- activeTools narrowing -------------------------------------------
  // The turn-level forced tool is threaded in so a narrowed palette can
  // never drop it — otherwise the AI SDK throws
  // `Tool '<name>' not found in provided tools` on the step. The
  // `hasPersistedWorkflow` signal gates `requires_persisted_workflow`
  // tools uniformly across stages so the production failure mode
  // (first-turn `build a workflow` looping on `run_workflow`) is
  // structurally closed.
  const activeTools = activeToolsForStage(
    signals.stage,
    toolsByName,
    params.forcedTool,
    signals.hasPersistedWorkflow === true,
  );
  if (activeTools !== undefined) {
    reasonParts.push(`narrow:${activeTools.length}`);
  }

  // ---- Multi-artifact continuation -------------------------------------
  // The user asked for "a connector AND a workflow". The harness just
  // auto-persisted the connector. Without a nudge the model often emits
  // a closing "Now let's build the workflow" sentence and exits the
  // turn — leaving the user to retype "yes" to continue. Force a tool
  // call on this step so the model proceeds with the workflow side of
  // the request instead of stopping on the promise.
  let toolChoice: StepDecision["toolChoice"];
  let systemNudge: string | undefined;
  if (signals.multiArtifactIntent === true && priorStepWasSuccessfulConnectorAutoPersist(params)) {
    // Anthropic API rejects thinking + forced tool_choice; the policy
    // helper is the single source of truth shared with `loop.ts`. When
    // thinking is on for the turn, the systemNudge alone has to carry
    // the constraint — the force becomes a soft instruction.
    const thinking = resolveThinking({
      enableThinking: params.turnThinkingEnabled === true,
      forcesTool: true, // about to consider forcing one
    });
    if (!thinking.suppressedByForcedTool) {
      toolChoice = "required";
    }
    systemNudge =
      "The user asked for both a connector AND a workflow in their most recent message. The connector is now saved. Continue with the workflow now — call the authoring tool author_workflow. Do NOT end the turn with a `now let's …` closing sentence; the user already approved the multi-artifact intent.";
    reasonParts.push(
      thinking.suppressedByForcedTool
        ? "multi_artifact_continue_nudge_only"
        : "multi_artifact_continue",
    );
  }

  if (
    modelId === undefined &&
    activeTools === undefined &&
    toolChoice === undefined &&
    systemNudge === undefined
  ) {
    return undefined;
  }
  const decision: StepDecision = {};
  if (modelId !== undefined) decision.modelId = modelId;
  if (activeTools !== undefined) decision.activeTools = activeTools;
  if (toolChoice !== undefined) decision.toolChoice = toolChoice;
  if (systemNudge !== undefined) decision.system = systemNudge;
  if (reasonParts.length > 0) decision.reason = reasonParts.join(",");
  return decision;
}

/**
 * Check the prior step's tool results for a successful
 * harness-auto-persist of `save_connector_draft`. Read defensively —
 * the AI SDK types `steps` as a generic `unknown[]` here, but the
 * runtime shape is `{ toolResults: { toolName, output }[] }` which the
 * stop-conditions in conversations/loop.ts already rely on.
 */
function priorStepWasSuccessfulConnectorAutoPersist(params: StepRouterParams): boolean {
  const prior = params.steps[params.steps.length - 1] as
    | {
        toolResults?: ReadonlyArray<{ toolName?: unknown; output?: unknown }>;
      }
    | undefined;
  const results = Array.isArray(prior?.toolResults) ? prior.toolResults : [];
  return results.some((r) => {
    if (r?.toolName !== "save_connector_draft") return false;
    const output = r.output as Record<string, unknown> | null | undefined;
    if (!output || typeof output !== "object") return false;
    return output.source === "harness_auto_persist" && output.ok === true;
  });
}

function isHardStage(stage: AuthoringStage | undefined): boolean {
  if (!stage) return false;
  // "Hard" = stages where the model is composing schema-shaped artefacts
  // or repairing. Routine reads / inspections do not qualify.
  switch (stage) {
    case "connector_validated":
    case "connector_persisted":
    case "workflow_validated":
    case "workflow_persisted":
    case "repairing":
      return true;
    default:
      return false;
  }
}
