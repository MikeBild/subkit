// Contract test for the TURN-ONE DISCIPLINE block in the converse
// system prompt. This block is the structural fix for the class of bug
// where the assistant calls `create_api_key` (or any other tenant_write
// tool) in response to an informational "how do I use subkit as an MCP
// server?" question — it must answer first, then offer to act, and only
// mint on explicit confirmation.
//
// A regression here re-opens the UX bug: the model sees a skill body
// that says "call create_api_key" and does so in turn one, bypassing
// the explanation. Keep this test loud.

import { describe, expect, it } from "bun:test";
import { basePromptFor } from "../context-assembler.ts";

describe("converse base prompt — TURN-ONE DISCIPLINE", () => {
  it("declares the TURN-ONE DISCIPLINE section and marks it as a hard constraint", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("TURN-ONE DISCIPLINE");
    expect(p).toContain("hard constraint");
  });

  it("states the answer-before-action rule with the informational-question framing", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toMatch(/ANSWER BEFORE ACTION/);
    expect(p).toMatch(/HOW DO I …/i);
    expect(p).toContain('"how do I X?"');
  });

  it("requires explicit user confirmation before a subsequent tenant_write", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("EXPLICIT CONFIRMATION GATES WRITES");
    expect(p).toMatch(/in their own words/);
  });

  it("caps state-changing tool calls at one per turn", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("ONE STATE-CHANGING TOOL PER TURN");
  });

  it("declares that this block overrides any skill body that says otherwise", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toMatch(/SKILL BODY CONFLICTS WITH THIS BLOCK, THIS BLOCK WINS/);
  });

  it("forbids fabricating account-specific values (keys, endpoints, tenant ids)", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("NO FABRICATION");
    expect(p).toContain("cannot_help");
  });

  it("lists create_api_key among the tenant_write tool names the rule applies to", () => {
    const p = basePromptFor("converse", "sk_interactive");
    expect(p).toContain("create_api_key");
  });

  it("applies to the mcp surface as well as sk_interactive", () => {
    const p = basePromptFor("converse", "mcp");
    expect(p).toContain("TURN-ONE DISCIPLINE");
    expect(p).toContain("ANSWER BEFORE ACTION");
  });
});
