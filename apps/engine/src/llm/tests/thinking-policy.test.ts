import { describe, expect, it } from "bun:test";
import { resolveThinking, resolveTurnReasoning } from "../runtime/thinking-policy.ts";

describe("resolveTurnReasoning", () => {
  const base = {
    lateStage: false,
    supportsThinking: false,
    supportsReasoningEffort: true,
    forcesTool: false,
  };

  it("keeps the stage default: none before a late stage, high on supported Claude late stages", () => {
    expect(resolveTurnReasoning({ ...base, setting: "default" }).effort).toBe("none");
    expect(
      resolveTurnReasoning({
        ...base,
        setting: "default",
        lateStage: true,
        supportsThinking: true,
      }),
    ).toEqual({
      enabled: true,
      suppressedByForcedTool: false,
      effort: "high",
      source: "stage_default",
    });
    expect(
      resolveTurnReasoning({
        ...base,
        setting: "default",
        lateStage: true,
        supportsThinking: false,
      }).effort,
    ).toBe("none");
  });

  it("applies an explicit effort to every stage on OpenAI reasoning models, also with a forced tool", () => {
    expect(resolveTurnReasoning({ ...base, setting: "medium" })).toEqual({
      enabled: true,
      suppressedByForcedTool: false,
      effort: "medium",
      source: "setting",
    });
    expect(resolveTurnReasoning({ ...base, setting: "medium", forcesTool: true }).effort).toBe(
      "medium",
    );
  });

  it("still suppresses thinking on Claude when a tool is forced", () => {
    expect(
      resolveTurnReasoning({
        ...base,
        setting: "low",
        supportsThinking: true,
        supportsReasoningEffort: false,
        forcesTool: true,
      }),
    ).toEqual({ enabled: false, suppressedByForcedTool: true, effort: "none", source: "setting" });
  });

  it("returns none for unsupported models and for the explicit none setting", () => {
    expect(
      resolveTurnReasoning({ ...base, setting: "high", supportsReasoningEffort: false }).effort,
    ).toBe("none");
    expect(
      resolveTurnReasoning({ ...base, setting: "none", lateStage: true, supportsThinking: true }),
    ).toEqual({ enabled: false, suppressedByForcedTool: false, effort: "none", source: "setting" });
  });
});

describe("resolveThinking", () => {
  it("enables thinking when the turn supports it and does NOT force a tool", () => {
    expect(resolveThinking({ enableThinking: true, forcesTool: false })).toEqual({
      enabled: true,
      suppressedByForcedTool: false,
    });
  });

  it("suppresses thinking when the turn forces a specific tool", () => {
    expect(resolveThinking({ enableThinking: true, forcesTool: true })).toEqual({
      enabled: false,
      suppressedByForcedTool: true,
    });
  });

  it("returns disabled-without-suppression when thinking is not supported", () => {
    expect(resolveThinking({ enableThinking: false, forcesTool: false })).toEqual({
      enabled: false,
      suppressedByForcedTool: false,
    });
  });

  it("does NOT flag suppression when thinking wasn't requested in the first place", () => {
    expect(resolveThinking({ enableThinking: false, forcesTool: true })).toEqual({
      enabled: false,
      suppressedByForcedTool: false,
    });
  });
});
