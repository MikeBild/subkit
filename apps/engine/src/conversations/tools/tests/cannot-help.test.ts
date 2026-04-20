// Unit tests for the cannot_help abstention tool. Cover schema
// enforcement, the returned shape consumed by the loop, and the
// optional-field round-trip behaviour the capability-gap analytics
// will read.

import { describe, expect, it } from "bun:test";
import { cannotHelpTool } from "../cannot-help.ts";
import type { ToolContext } from "../index.ts";

const ctx = {} as ToolContext;

describe("cannot_help", () => {
  it("registers as a tenant_read tool with a stable name", () => {
    expect(cannotHelpTool.name).toBe("cannot_help");
    expect(cannotHelpTool.category).toBe("tenant_read");
  });

  it("returns ok=true with abstained=true and the verbatim reason", async () => {
    const result = await cannotHelpTool.execute(ctx, {
      reason: "I do not have a verified Codex MCP config in this engine yet.",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      abstained: true,
      reason: "I do not have a verified Codex MCP config in this engine yet.",
    });
  });

  it("round-trips the optional missing_capability and suggest_alternative", async () => {
    const result = await cannotHelpTool.execute(ctx, {
      reason: "no recipe",
      missing_capability: "vendor_recipe.codex",
      suggest_alternative: "Check the official Codex MCP docs.",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      abstained: true,
      reason: "no recipe",
      missing_capability: "vendor_recipe.codex",
      suggest_alternative: "Check the official Codex MCP docs.",
    });
  });

  it("rejects an empty reason", () => {
    expect(() => cannotHelpTool.execute(ctx, { reason: "" })).toThrow();
  });

  it("rejects a missing reason", () => {
    expect(() => cannotHelpTool.execute(ctx, {})).toThrow();
  });

  it("rejects unknown fields outright (sealSchema applied at registration)", async () => {
    // sealSchema (deliverable D4) toggles every conversation-tool input
    // schema to `.strict()` — extra keys are no longer silently dropped,
    // they fail the parse. Note: cannotHelpTool.execute() uses the
    // module-level inputSchema reference (still .passthrough by default
    // because .execute() bypasses the registry); the strict flavour is
    // what the LLM SDK enforces via the wrapped tool. This test
    // documents that distinction explicitly.
    const sealedFromRegistry = (
      await import("../index.ts")
    ).getTool("cannot_help")!.inputSchema;
    expect(
      sealedFromRegistry.safeParse({ reason: "ok", not_a_real_field: "x" }).success,
    ).toBe(false);
  });
});
