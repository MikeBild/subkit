// Tests for the resolveThinking helper — single source of truth for
// the Anthropic "thinking is incompatible with forced tool_choice"
// constraint shared between loop.ts and step-router.ts.

import { describe, expect, it } from "bun:test";

import { resolveThinking } from "../core/thinking-policy.ts";

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
    // Even if the turn forces a tool, if thinking was never on we
    // shouldn't surface a misleading "suppressed" signal.
    expect(resolveThinking({ enableThinking: false, forcesTool: true })).toEqual({
      enabled: false,
      suppressedByForcedTool: false,
    });
  });
});
