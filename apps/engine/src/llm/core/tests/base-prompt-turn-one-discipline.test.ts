// Contract test for the TURN-ONE DISCIPLINE behaviour skill that the
// MAIN agent preloads on every converse turn. The literal lives in
// `apps/engine/src/conversations/agent/skills/content/turn-one-discipline.md`;
// the registry wires it via `MAIN.preloadedSkills`.

import { describe, expect, it } from "bun:test";

import { basePromptFor } from "../context-assembler.ts";

describe("converse base prompt — TURN-ONE DISCIPLINE behaviour skill", () => {
  it("declares the TURN-ONE DISCIPLINE section and marks it as a hard constraint", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("TURN-ONE DISCIPLINE");
    expect(p).toContain("hard constraint");
  });

  it("states the answer-before-action rule with the informational-question framing", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toMatch(/ANSWER BEFORE ACTION/);
    expect(p).toMatch(/HOW DO I …/i);
    expect(p).toContain('"how do I X?"');
  });

  it("requires explicit user confirmation before a subsequent tenant_write", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("EXPLICIT CONFIRMATION GATES WRITES");
    expect(p).toMatch(/in their own words/);
  });

  it("caps state-changing tool calls at one per turn", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("ONE STATE-CHANGING TOOL PER TURN");
  });

  it("declares that this block overrides any skill body that says otherwise", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toMatch(/SKILL BODY CONFLICTS WITH THIS BLOCK, THIS BLOCK WINS/);
  });

  it("forbids fabricating account-specific values (keys, endpoints, tenant ids)", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("NO FABRICATION");
    expect(p).toContain("cannot_help");
  });

  it("lists create_api_key among the tenant_write tool names the rule applies to", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("create_api_key");
  });

  it("applies to the mcp surface as well as sk_interactive", async () => {
    const p = (await basePromptFor("converse", "mcp")).content;
    expect(p).toContain("TURN-ONE DISCIPLINE");
    expect(p).toContain("ANSWER BEFORE ACTION");
  });
});
