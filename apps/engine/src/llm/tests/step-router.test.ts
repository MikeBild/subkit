// Unit tests for the converse-loop step router.

import { describe, expect, it, test } from "bun:test";
import type { ConversationTool } from "../../conversations/tools/index.ts";
import {
  prepareStep,
  routeTop,
  routeUp,
  type StepRouterParams,
  supportsExtendedThinking,
} from "../core/step-router.ts";
import type { LlmProviderKind } from "../types.ts";

function fakeTool(
  name: string,
  category: ConversationTool["category"],
  opts: {
    requires_persisted_workflow?: boolean;
    authoring_resource?: ConversationTool["authoring_resource"];
  } = {},
): [string, ConversationTool] {
  return [
    name,
    {
      name,
      description: name,
      // biome-ignore lint/suspicious/noExplicitAny: test stub doesn't need a real schema
      inputSchema: {} as any,
      category,
      execute: async () => ({ ok: true, data: {} }),
      ...(opts.requires_persisted_workflow === true
        ? { requires_persisted_workflow: true as const }
        : {}),
      ...(opts.authoring_resource ? { authoring_resource: opts.authoring_resource } : {}),
    },
  ];
}

const TOOLS: Record<string, ConversationTool> = Object.fromEntries([
  fakeTool("ask_user_text", "draft_write"),
  fakeTool("inspect_workflow", "tenant_read"),
  fakeTool("list_workflows", "tenant_read"),
  fakeTool("edit_workflow_patch", "draft_write", { authoring_resource: "workflow" }),
  fakeTool("save_workflow_draft", "tenant_write", { authoring_resource: "workflow" }),
  fakeTool("author_workflow", "draft_write", { authoring_resource: "workflow" }),
  fakeTool("inspect_connector_draft", "draft_write", { authoring_resource: "connector" }),
  fakeTool("probe_connector_draft", "draft_write", { authoring_resource: "connector" }),
  // delete_workflow / update_workflow target an existing workflow by explicit
  // id/slug — they are NOT requires_persisted_workflow (see cleanup.ts /
  // update-workflow.ts) and must stay reachable on a fresh conversation.
  fakeTool("delete_workflow", "tenant_write"),
  fakeTool("update_workflow", "tenant_write"),
  fakeTool("create_schedule", "tenant_write", { requires_persisted_workflow: true }),
  fakeTool("run_workflow", "tenant_write", { requires_persisted_workflow: true }),
]);

function baseParams(over: Partial<StepRouterParams> = {}): StepRouterParams {
  return {
    stepNumber: 1,
    steps: [],
    messages: [],
    // biome-ignore lint/suspicious/noExplicitAny: not exercised by the router
    model: {} as any,
    tenantDefaultModelId: "claude-sonnet-4-5",
    provider: "anthropic" as LlmProviderKind,
    toolsByName: TOOLS,
    signals: {},
    ...over,
  };
}

describe("routeUp / routeTop ladder", () => {
  it("returns the next-tier-up id on Anthropic", () => {
    expect(routeUp("anthropic", "claude-sonnet-4-5")).toBe("claude-opus-4-7");
    expect(routeUp("anthropic", "claude-haiku-4-5")).toBe("claude-sonnet-4-6");
  });

  it("escalates opus-4-7 to opus-4-8 (the new ladder top)", () => {
    // opus-4-7 used to be the top (identity → escalation no-op, which the
    // runtime-logs review flagged via step_router.no_upgrade_available).
    // opus-4-8 is now the top, so the authoring-seed tier escalates.
    expect(routeUp("anthropic", "claude-opus-4-7")).toBe("claude-opus-4-8");
    expect(routeTop("anthropic", "claude-opus-4-7")).toBe("claude-opus-4-8");
  });

  it("returns identity at the top of the ladder (opus-4-8)", () => {
    expect(routeUp("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(routeTop("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("routes through OpenAI tiers", () => {
    expect(routeUp("openai", "gpt-4o-mini")).toBe("gpt-4o");
    expect(routeUp("openai", "gpt-4o")).toBe("gpt-4.1");
    expect(routeTop("openai", "gpt-4o-mini")).toBe("gpt-4.1");
  });

  it("strips provider prefixes before lookup", () => {
    expect(routeUp("gateway", "anthropic/claude-sonnet-4-5")).toBe("claude-opus-4-7");
  });

  it("strips date suffixes before lookup", () => {
    expect(routeUp("anthropic", "claude-haiku-4-5-20251001")).toBe("claude-sonnet-4-6");
    expect(routeUp("openai", "gpt-4o-2024-11-20")).toBe("gpt-4.1");
  });

  it("covers the older Claude 3.5 line", () => {
    expect(routeUp("anthropic", "claude-3-5-haiku")).toBe("claude-3-5-sonnet");
    expect(routeUp("anthropic", "claude-3-5-sonnet")).toBe("claude-3-opus");
  });

  it("covers gpt-4-turbo", () => {
    expect(routeUp("openai", "gpt-4-turbo")).toBe("gpt-4o");
  });

  it("covers gemini 1.5 + 2.0 + 2.5 lines", () => {
    expect(routeUp("gemini", "gemini-1.5-flash")).toBe("gemini-1.5-pro");
    expect(routeUp("gemini", "gemini-2.0-flash")).toBe("gemini-2.5-pro");
  });

  it("identity for providers without a ladder", () => {
    expect(routeUp("mock" as LlmProviderKind, "anything")).toBe("anything");
  });
});

describe("supportsExtendedThinking", () => {
  it("true for Sonnet 4.5+ / Opus 4.6+", () => {
    expect(supportsExtendedThinking("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(supportsExtendedThinking("anthropic", "claude-opus-4-7")).toBe(true);
  });

  it("false for Haiku", () => {
    expect(supportsExtendedThinking("anthropic", "claude-haiku-4-5")).toBe(false);
  });

  it("false for non-Anthropic providers", () => {
    expect(supportsExtendedThinking("openai", "gpt-4o")).toBe(false);
  });
});

describe("prepareStep — passthrough as default", () => {
  it("returns undefined when stage is idle AND a persisted workflow is bound (full palette)", () => {
    expect(
      prepareStep(baseParams({ signals: { stage: "idle", hasPersistedWorkflow: true } })),
    ).toBeUndefined();
  });

  it("drops run_workflow on the FIRST authoring turn — nothing persisted yet", () => {
    // Load-bearing. This is the assurance that let the hard-coded
    // premium-model authoring seed be deleted: the failure it was bought
    // for — `conversation_start("build a workflow ...")` firing
    // `run_workflow{}` on a not-yet-persisted draft until loop detection
    // stopped it — is prevented structurally, not by paying for a model
    // clever enough to resist the temptation. The tool is not in the
    // palette, so no model can pick it.
    const decision = prepareStep(
      baseParams({ signals: { stage: "idle", hasPersistedWorkflow: false } }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).not.toContain("run_workflow");
    expect(decision?.activeTools).not.toContain("create_schedule");
    // Authoring itself must stay reachable, or the drop would just trade
    // one dead end for another.
    expect(decision?.activeTools).toContain("save_workflow_draft");
  });

  it("returns undefined when stage and persisted-workflow signal are both unset (synthetic)", () => {
    // With no stage AND no hasPersistedWorkflow flag, the gate defaults
    // to "no persisted workflow" which would normally narrow the
    // palette. But there are no `requires_persisted_workflow` tools
    // visible in the tools map if we strip the test fixture down, so
    // here we explicitly assert the gate fires (activeTools defined).
    const decision = prepareStep(baseParams({ signals: {} }));
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).not.toContain("run_workflow");
  });
});

describe("prepareStep — escalation rules", () => {
  it("escalates one tier up on hadRepairThisTurn", () => {
    const decision = prepareStep(baseParams({ signals: { hadRepairThisTurn: true } }));
    expect(decision?.modelId).toBe("claude-opus-4-7");
    expect(decision?.reason).toContain("repair_in_prior_step");
  });

  it("escalates one tier up on strongRunIntent", () => {
    const decision = prepareStep(baseParams({ signals: { strongRunIntent: true } }));
    expect(decision?.modelId).toBe("claude-opus-4-7");
    expect(decision?.reason).toContain("strong_run_intent");
  });

  it("escalates one tier up on hard stage", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_validated" } }));
    expect(decision?.modelId).toBe("claude-opus-4-7");
    expect(decision?.reason).toContain("hard_stage");
  });

  it("escalates to top tier (opus-4-8) on priorCriticFail", () => {
    const decision = prepareStep(baseParams({ signals: { priorCriticFail: true } }));
    expect(decision?.modelId).toBe("claude-opus-4-8");
    expect(decision?.reason).toContain("prior_critic_fail");
  });

  it("never downgrades from the top tier", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-opus-4-8",
        signals: { priorCriticFail: true },
      }),
    );
    // No-op upgrade — opus-4-8 is already top, so modelId is not set.
    expect(decision?.modelId).toBeUndefined();
  });

  it("escalates Haiku to Sonnet on hard stages", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-haiku-4-5",
        signals: { stage: "workflow_validated" },
      }),
    );
    expect(decision?.modelId).toBe("claude-sonnet-4-6");
  });
});

describe("prepareStep — chat surface suppresses the authoring hard-stage escalation (P2)", () => {
  it("does NOT escalate on stage='workflow_persisted' when surface='chat'", () => {
    // The production bug: a chat conversation with a bound workflow parks on
    // `workflow_persisted` (an AUTHORING marker) and escalated haiku→sonnet on
    // every turn with reason `hard_stage:workflow_persisted`. Chat is
    // read-only and cannot author, so no swap must happen.
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-haiku-4-5",
        signals: { stage: "workflow_persisted", surface: "chat" },
      }),
    );
    // No model swap and no hard_stage reason. `workflow_persisted` returns the
    // full palette (undefined activeTools) and no other signal fires, so the
    // whole decision collapses to `undefined`.
    expect(decision?.modelId).toBeUndefined();
    expect(decision?.reason ?? "").not.toContain("hard_stage");
  });

  it("STILL escalates on stage='workflow_persisted' for a non-chat surface (regression)", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-haiku-4-5",
        signals: { stage: "workflow_persisted", surface: "sk_interactive" },
      }),
    );
    expect(decision?.modelId).toBe("claude-sonnet-4-6");
    expect(decision?.reason).toContain("hard_stage:workflow_persisted");
  });

  it("STILL escalates on chat when a genuine-difficulty signal fires (priorCriticFail)", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-haiku-4-5",
        signals: { surface: "chat", priorCriticFail: true },
      }),
    );
    // priorCriticFail is a genuine difficulty signal — it must escalate on
    // every surface, chat included, all the way to the top tier.
    expect(decision?.modelId).toBe("claude-opus-4-8");
    expect(decision?.reason).toContain("prior_critic_fail");
  });
});

describe("prepareStep — activeTools narrowing", () => {
  it("narrows to tenant_read tools on discover stages", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_targeted" } }));
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).toContain("inspect_workflow");
    expect(decision?.activeTools).toContain("list_workflows");
    expect(decision?.activeTools).toContain("ask_user_text"); // always-available
    expect(decision?.activeTools).not.toContain("save_workflow_draft");
    expect(decision?.activeTools).not.toContain("delete_workflow");
  });

  it("includes draft_write tools on propose stages", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_inspected" } }));
    expect(decision?.activeTools).toContain("edit_workflow_patch");
    expect(decision?.activeTools).toContain("inspect_workflow");
    expect(decision?.activeTools).not.toContain("save_workflow_draft");
    expect(decision?.activeTools).not.toContain("probe_connector_draft");
  });

  it("keeps connector authoring stages free of workflow draft tools", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "connector_validated" } }));
    expect(decision?.activeTools).toContain("inspect_connector_draft");
    expect(decision?.activeTools).toContain("probe_connector_draft");
    expect(decision?.activeTools).not.toContain("author_workflow");
    expect(decision?.activeTools).not.toContain("edit_workflow_patch");
    expect(decision?.activeTools).not.toContain("save_workflow_draft");
  });

  it("returns full palette on commit/execute stages", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_persisted" } }));
    // workflow_persisted is hard, so escalation fires; activeTools stays
    // unset (full palette) so save_workflow_draft / delete_workflow remain
    // available.
    expect(decision?.activeTools).toBeUndefined();
  });
});

describe("prepareStep — forced tool survives activeTools narrowing (FIX 4 / BUG-3)", () => {
  it("keeps a forced run_workflow in activeTools even though the stage drops tenant_write", () => {
    // `workflow_previewed` narrows to tenant_read + draft_write and
    // would otherwise drop `run_workflow` (a tenant_write tool). The AI
    // SDK validates the turn-level forced tool against EVERY step's
    // activeTools — if it is missing the SDK throws
    // `Tool 'run_workflow' not found in provided tools`.
    const decision = prepareStep(
      baseParams({
        signals: { stage: "workflow_previewed" },
        stepNumber: 0,
        forcedTool: "run_workflow",
      }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).toContain("run_workflow");
    // The narrowing itself still happens — only the forced tool is re-added.
    expect(decision?.activeTools).toContain("edit_workflow_patch");
    expect(decision?.activeTools).not.toContain("delete_workflow");
  });

  it("narrowing still drops tenant_write tools that are NOT the forced tool", () => {
    const decision = prepareStep(
      baseParams({
        signals: { stage: "workflow_previewed" },
        stepNumber: 0,
        forcedTool: "run_workflow",
      }),
    );
    expect(decision?.activeTools).not.toContain("save_workflow_draft");
  });

  it("no forced tool — narrowing drops every tenant_write tool as before", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_previewed" } }));
    expect(decision?.activeTools).not.toContain("run_workflow");
    expect(decision?.activeTools).not.toContain("save_workflow_draft");
  });
});

describe("prepareStep — multi-artifact continuation", () => {
  // Synthesise the AI SDK step-shape the router reads — only the
  // toolResults[].toolName / toolResults[].output.{source,ok} fields
  // matter to `priorStepWasSuccessfulConnectorAutoPersist`.
  function priorStep(toolName: string, output: unknown) {
    return { toolResults: [{ toolName, output }] };
  }

  it("forces toolChoice='required' after a successful save_connector_draft auto-persist", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { source: "harness_auto_persist", ok: true })],
        signals: { multiArtifactIntent: true, stage: "connector_persisted" },
      }),
    );
    expect(decision?.toolChoice).toBe("required");
    expect(decision?.system).toMatch(/connector AND a workflow/i);
    expect(decision?.reason).toContain("multi_artifact_continue");
  });

  it("does NOT force toolChoice when multiArtifactIntent is false", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { source: "harness_auto_persist", ok: true })],
        signals: { stage: "connector_persisted" },
      }),
    );
    expect(decision?.toolChoice).toBeUndefined();
  });

  it("does NOT force toolChoice when the prior step's auto-persist FAILED", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { source: "harness_auto_persist", ok: false })],
        signals: { multiArtifactIntent: true, stage: "connector_persisted" },
      }),
    );
    expect(decision?.toolChoice).toBeUndefined();
  });

  it("does NOT force toolChoice when the prior tool was an LLM-issued save (no harness source)", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { ok: true })],
        signals: { multiArtifactIntent: true, stage: "connector_persisted" },
      }),
    );
    expect(decision?.toolChoice).toBeUndefined();
  });

  it("does NOT force toolChoice when there is no prior step (turn just started)", () => {
    const decision = prepareStep(
      baseParams({
        steps: [],
        signals: { multiArtifactIntent: true, stage: "idle" },
      }),
    );
    expect(decision?.toolChoice).toBeUndefined();
  });

  // Fix 4: Anthropic API rejects thinking + forced tool_choice. When
  // the loop has enabled thinking for the turn, the router must NOT
  // upgrade the nudge into a hard `toolChoice: "required"` — the
  // systemNudge alone has to do the work.
  it("does NOT force toolChoice when turnThinkingEnabled is true (Anthropic API constraint)", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { source: "harness_auto_persist", ok: true })],
        signals: { multiArtifactIntent: true, stage: "connector_persisted" },
        turnThinkingEnabled: true,
      }),
    );
    expect(decision?.toolChoice).toBeUndefined();
    // The systemNudge should still fire — it's a soft instruction
    // compatible with thinking.
    expect(decision?.system).toMatch(/connector AND a workflow/i);
    expect(decision?.reason).toContain("multi_artifact_continue_nudge_only");
  });

  it("forces toolChoice when turnThinkingEnabled is false (existing path)", () => {
    const decision = prepareStep(
      baseParams({
        steps: [priorStep("save_connector_draft", { source: "harness_auto_persist", ok: true })],
        signals: { multiArtifactIntent: true, stage: "connector_persisted" },
        turnThinkingEnabled: false,
      }),
    );
    expect(decision?.toolChoice).toBe("required");
  });
});

// 6.0.3 hotfix — FIX 1: pre-persistence workflow stages must drop tools
// that require a persisted `workflows` row. Without this the LLM picked
// `run_workflow` on a `build a workflow called X` turn, failing 3x and
// tripping `tool.loop_detected`. The fix exposes a tool-level
// `requires_persisted_workflow: true` flag; the step-router filters on
// it for the workflow-side pre-persistence stages.
describe("prepareStep — pre-persistence stages drop tools requiring a persisted workflow (6.0.3)", () => {
  const PRE_PERSISTENCE_STAGES = [
    "workflow_draft_started",
    "workflow_inspected",
    "workflow_validated",
    "workflow_previewed",
  ] as const;

  for (const stage of PRE_PERSISTENCE_STAGES) {
    it(`drops run_workflow + peers on stage='${stage}'`, () => {
      const decision = prepareStep(baseParams({ signals: { stage } }));
      expect(decision?.activeTools).toBeDefined();
      // These stages narrow to tenant_read + draft_write, so EVERY tenant_write
      // tool is gone here — run_workflow/create_schedule (flagged) and
      // delete_workflow/update_workflow (dropped by category, not the flag).
      expect(decision?.activeTools).not.toContain("run_workflow");
      expect(decision?.activeTools).not.toContain("update_workflow");
      expect(decision?.activeTools).not.toContain("delete_workflow");
      expect(decision?.activeTools).not.toContain("create_schedule");
      expect(decision?.activeTools).not.toContain("save_workflow_draft");
      // The authoring tools the LLM should be picking instead must
      // still be in the palette.
      expect(decision?.activeTools).toContain("author_workflow");
      expect(decision?.activeTools).toContain("edit_workflow_patch");
      expect(decision?.activeTools).toContain("inspect_workflow");
      expect(decision?.activeTools).toContain("ask_user_text");
    });
  }

  it("INCLUDES run_workflow on stage='workflow_persisted' (post-persistence — full palette)", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_persisted" } }));
    // workflow_persisted returns undefined (full palette) — every
    // tenant_write tool, including run_workflow, is back on the menu.
    expect(decision?.activeTools).toBeUndefined();
  });

  it("INCLUDES run_workflow on stage='workflow_executed' (post-persistence — full palette)", () => {
    const decision = prepareStep(baseParams({ signals: { stage: "workflow_executed" } }));
    expect(decision?.activeTools).toBeUndefined();
  });

  it("forced run_workflow SURVIVES the requires_persisted_workflow drop", () => {
    // The two invariants coexist: the drop pass governs the default
    // authoring palette; the forced-tool path is an explicit operator
    // override that the AI SDK validates against the per-step
    // activeTools — if the router doesn't keep it the SDK throws
    // `Tool 'run_workflow' not found in provided tools` and the turn
    // fails.
    for (const stage of PRE_PERSISTENCE_STAGES) {
      const decision = prepareStep(
        baseParams({ signals: { stage }, stepNumber: 0, forcedTool: "run_workflow" }),
      );
      expect(decision?.activeTools).toBeDefined();
      expect(decision?.activeTools).toContain("run_workflow");
      // At these draft stages the category narrowing (tenant_read +
      // draft_write) drops every other tenant_write tool — the flagged
      // create_schedule and the unflagged delete/update_workflow alike.
      expect(decision?.activeTools).not.toContain("update_workflow");
      expect(decision?.activeTools).not.toContain("delete_workflow");
      expect(decision?.activeTools).not.toContain("create_schedule");
    }
  });
});

// SHOULD-FIX 1 + 2 (6.0.3 review): the drop pass must be GATED ON THE
// LIVE DRAFT STATE, not just the stage. The original production failure
// fired at stage='idle' (first turn of `conversation_start("build a
// workflow ...")`), which the stage-only gate did not cover. The fix
// drops `requires_persisted_workflow` tools whenever
// `hasPersistedWorkflow` is false — including `idle`, `repairing`, and
// `connector_persisted` when no workflow is bound yet.
describe("prepareStep — live-state gate drops persisted-workflow tools across stages (6.0.3)", () => {
  it("idle + no persisted workflow → drops run_workflow (matches the production failure mode)", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "idle", hasPersistedWorkflow: false } }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).not.toContain("run_workflow");
    expect(decision?.activeTools).not.toContain("create_schedule");
    // Regression guard (session 85ce71d7): delete_workflow / update_workflow
    // are NOT requires_persisted_workflow — they resolve an existing workflow
    // by explicit id/slug, so on a fresh "list then delete/rename workflow X"
    // conversation they must stay reachable. Hiding them is what forced the
    // model onto delete_connector and the connector_not_found dead-end.
    expect(decision?.activeTools).toContain("delete_workflow");
    expect(decision?.activeTools).toContain("update_workflow");
    // Authoring tools (and the always-available set) remain.
    expect(decision?.activeTools).toContain("author_workflow");
    expect(decision?.activeTools).toContain("edit_workflow_patch");
    expect(decision?.activeTools).toContain("ask_user_text");
  });

  it("idle + persisted workflow BOUND → full palette (no narrowing)", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "idle", hasPersistedWorkflow: true } }),
    );
    // No narrowing, full palette — the conversation can use any tool
    // because a saved workflow is bound.
    expect(decision?.activeTools).toBeUndefined();
  });

  it("connector_persisted + no persisted workflow → drops run_workflow", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "connector_persisted", hasPersistedWorkflow: false } }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).not.toContain("run_workflow");
    expect(decision?.activeTools).not.toContain("create_schedule");
    // Unflagged management ops survive the full-palette drop (see idle case).
    expect(decision?.activeTools).toContain("delete_workflow");
    expect(decision?.activeTools).toContain("update_workflow");
  });

  it("connector_persisted + persisted workflow BOUND → full palette", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "connector_persisted", hasPersistedWorkflow: true } }),
    );
    expect(decision?.activeTools).toBeUndefined();
  });

  it("repairing + no persisted workflow → drops run_workflow (still safe under repair)", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "repairing", hasPersistedWorkflow: false } }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).not.toContain("run_workflow");
  });

  it("repairing + persisted workflow BOUND → full palette", () => {
    const decision = prepareStep(
      baseParams({ signals: { stage: "repairing", hasPersistedWorkflow: true } }),
    );
    expect(decision?.activeTools).toBeUndefined();
  });

  it("forced run_workflow + idle + no persisted workflow → still re-added (forced-tool invariant)", () => {
    const decision = prepareStep(
      baseParams({
        signals: { stage: "idle", hasPersistedWorkflow: false },
        stepNumber: 0,
        forcedTool: "run_workflow",
      }),
    );
    expect(decision?.activeTools).toBeDefined();
    expect(decision?.activeTools).toContain("run_workflow");
    // Flagged peer still drops; unflagged management ops survive.
    expect(decision?.activeTools).not.toContain("create_schedule");
    expect(decision?.activeTools).toContain("delete_workflow");
    expect(decision?.activeTools).toContain("update_workflow");
  });
});

describe("intent-directed execution hands control back after the first step", () => {
  it("releases the forced tool even when the full palette needs no narrowing", () => {
    const decision = prepareStep(
      baseParams({
        stepNumber: 1,
        forcedTool: "run_workflow",
        signals: { stage: "workflow_executed", hasPersistedWorkflow: true },
      }),
    );
    expect(decision?.toolChoice).toBe("auto");
  });
  it("keeps the bound runner optional rather than forcing it again after review", () => {
    const decision = prepareStep(
      baseParams({
        stepNumber: 2,
        forcedTool: "run_workflow",
        signals: { stage: "workflow_previewed", hasPersistedWorkflow: true },
      }),
    );
    expect(decision?.toolChoice).toBe("auto");
    expect(decision?.activeTools).toContain("run_workflow");
    expect(decision?.activeTools).toContain("inspect_workflow");
  });
});

describe("a trimmed-snapshot enumeration forces list_workflows only for the first step", () => {
  test("step 0 keeps the stream-level force", () => {
    const decision = prepareStep(baseParams({ stepNumber: 0, forcedTool: "list_workflows" }));
    expect(decision?.toolChoice).toBeUndefined();
  });

  test("step 1 releases it so the model can answer from the list", () => {
    const decision = prepareStep(baseParams({ stepNumber: 1, forcedTool: "list_workflows" }));
    expect(decision?.toolChoice).toBe("auto");
  });
});

describe("saved workflow inspection keeps preparation reachable", () => {
  const stages = [
    "workflow_targeted",
    "diagnosing",
    "workflow_inspected",
    "workflow_validated",
    "workflow_previewed",
  ] as const;
  for (const stage of stages) {
    it(`keeps the bound runner after ${stage} without exposing unrelated writes`, () => {
      const decision = prepareStep(baseParams({ signals: { stage, hasPersistedWorkflow: true } }));
      expect(decision?.activeTools).toContain("run_workflow");
      expect(decision?.activeTools).not.toContain("create_schedule");
      expect(decision?.activeTools).not.toContain("delete_workflow");
      expect(
        prepareStep(baseParams({ signals: { stage, hasPersistedWorkflow: false } }))?.activeTools,
      ).not.toContain("run_workflow");
    });
  }
  it("does not restore a runner removed by the outer no-run or target gate", () => {
    const { run_workflow: _runner, ...toolsByName } = TOOLS;
    const decision = prepareStep(
      baseParams({
        toolsByName,
        signals: { stage: "workflow_inspected", hasPersistedWorkflow: true },
      }),
    );
    expect(decision?.activeTools).not.toContain("run_workflow");
  });
});

test("diagnosis keeps same-chat workflow repair available without exposing unrelated writes", () => {
  const decision = prepareStep(
    baseParams({ signals: { stage: "diagnosing", hasPersistedWorkflow: true } }),
  );
  expect(decision?.activeTools).toContain("edit_workflow_patch");
  expect(decision?.activeTools).toContain("inspect_workflow");
  expect(decision?.activeTools).not.toContain("probe_connector_draft");
  expect(decision?.activeTools).not.toContain("delete_workflow");
  expect(decision?.activeTools).not.toContain("save_workflow_draft");
  const withoutEditor = { ...TOOLS };
  delete withoutEditor.edit_workflow_patch;
  expect(
    prepareStep(
      baseParams({
        toolsByName: withoutEditor,
        signals: { stage: "diagnosing", hasPersistedWorkflow: true },
      }),
    )?.activeTools,
  ).not.toContain("edit_workflow_patch");
});
