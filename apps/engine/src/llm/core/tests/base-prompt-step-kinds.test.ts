// Guards the WORKFLOW STEP KINDS section of the converse + generate
// system prompts. Without this section the model invents Zapier-style
// kinds like `trigger.manual` / `flow.approval` that propose_step
// rejects, causing self-reinforcing tool failures.

import { describe, expect, it } from "bun:test";
import { basePromptFor } from "../context-assembler.ts";

const ALL_KINDS = [
  "request",
  "transform",
  "call",
  "wait",
  "branch",
  "parallel",
  "loop",
  "tool",
] as const;

describe("base prompts — step-kind enumeration", () => {
  it("converse prompt (sk_interactive) lists all 8 kinds", () => {
    const p = basePromptFor("converse", "sk_interactive");
    for (const k of ALL_KINDS) {
      expect(p).toContain(`\`${k}\``);
    }
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("propose_step");
  });

  it("converse prompt (mcp) lists all 8 kinds", () => {
    const p = basePromptFor("converse", "mcp");
    for (const k of ALL_KINDS) expect(p).toContain(`\`${k}\``);
  });

  it("generate prompt lists all 8 kinds (incl. tool)", () => {
    const p = basePromptFor("generate");
    for (const k of ALL_KINDS) expect(p).toContain(k);
  });

  it("converse prompt warns against the wrong discriminator key", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("never `type`");
  });

  it("converse prompt grounds cleanup actions to explicit tools only", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("delete_workflow");
    expect(p).toContain("revoke_api_key");
    expect(p).toContain("Do NOT invent a UI");
    expect(p).toContain("There is no generic Subkit web UI/dashboard");
  });

  it("converse prompt includes sk-first product-help facts", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("/openapi.json");
    expect(p).toContain("/docs");
    expect(p).toContain("subkit mcp");
    expect(p).toContain("Google Chat is a first-class chat adapter");
    // Scheduler tools ARE exposed now (A8); the prompt names them
    // so the LLM recommends `tenant.create_schedule` rather than
    // claiming scheduling is impossible.
    expect(p).toContain("tenant.create_schedule");
    expect(p).toContain("every:<seconds>");
    expect(p).toContain("/permissions");
  });
});
