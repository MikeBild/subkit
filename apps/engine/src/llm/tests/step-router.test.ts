// Unit tests for the converse-loop step router.

import { describe, expect, it } from "bun:test";
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
    },
  ];
}

const TOOLS: Record<string, ConversationTool> = Object.fromEntries([
  fakeTool("ask_user_text", "draft_write"),
  fakeTool("inspect_workflow", "tenant_read"),
  fakeTool("list_workflows", "tenant_read"),
  fakeTool("propose_step", "draft_write"),
  fakeTool("save_workflow_draft", "tenant_write"),
  fakeTool("delete_workflow", "tenant_write"),
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
    expect(routeUp("anthropic", "claude-haiku-4-5")).toBe("claude-sonnet-4-5");
  });

  it("returns identity at the top of the ladder", () => {
    expect(routeUp("anthropic", "claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(routeTop("anthropic", "claude-opus-4-7")).toBe("claude-opus-4-7");
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
    expect(routeUp("anthropic", "claude-haiku-4-5-20251001")).toBe("claude-sonnet-4-5");
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
  it("returns undefined when no signals fire and stage is idle", () => {
    expect(prepareStep(baseParams({ signals: { stage: "idle" } }))).toBeUndefined();
  });

  it("returns undefined when stage is undefined", () => {
    expect(prepareStep(baseParams({ signals: {} }))).toBeUndefined();
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

  it("escalates to top tier on priorCriticFail", () => {
    const decision = prepareStep(baseParams({ signals: { priorCriticFail: true } }));
    expect(decision?.modelId).toBe("claude-opus-4-7");
    expect(decision?.reason).toContain("prior_critic_fail");
  });

  it("never downgrades from the top tier", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-opus-4-7",
        signals: { priorCriticFail: true },
      }),
    );
    // No-op upgrade — opus is already top, so modelId is not set.
    expect(decision?.modelId).toBeUndefined();
  });

  it("escalates Haiku to Sonnet on hard stages", () => {
    const decision = prepareStep(
      baseParams({
        tenantDefaultModelId: "claude-haiku-4-5",
        signals: { stage: "workflow_validated" },
      }),
    );
    expect(decision?.modelId).toBe("claude-sonnet-4-5");
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
    expect(decision?.activeTools).toContain("propose_step");
    expect(decision?.activeTools).toContain("inspect_workflow");
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
});
