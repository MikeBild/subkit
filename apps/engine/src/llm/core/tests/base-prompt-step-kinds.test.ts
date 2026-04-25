// Guards the WORKFLOW STEP KINDS behaviour skill body + the cleanup /
// product-help skill body. Without the kind enumeration the model
// invents Zapier-style namespaces (`trigger.manual` / `flow.approval`)
// that propose_step rejects, causing self-reinforcing tool failures.
// Without the cleanup section the model falls back to "this isn't
// supported" prose for delete_workflow / revoke_api_key requests.

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

describe("base prompts — step-kind enumeration + cleanup facts", () => {
  it("converse prompt (sk_interactive) lists all 8 kinds", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    for (const k of ALL_KINDS) {
      expect(p).toContain(`\`${k}\``);
    }
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("propose_step");
  });

  it("converse prompt (mcp) lists all 8 kinds", async () => {
    const p = await basePromptFor("converse", "mcp");
    for (const k of ALL_KINDS) expect(p).toContain(`\`${k}\``);
  });

  it("generate prompt lists all 8 kinds (incl. tool)", async () => {
    const p = await basePromptFor("generate");
    for (const k of ALL_KINDS) expect(p).toContain(k);
  });

  it("converse prompt warns against the wrong discriminator key", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    expect(p).toContain("never `type`");
  });

  it("converse prompt grounds cleanup actions to explicit tools only", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    expect(p).toContain("delete_workflow");
    expect(p).toContain("revoke_api_key");
    expect(p).toContain("Do NOT invent a UI");
    expect(p).toContain("There is no generic Subkit web UI/dashboard");
  });

  it("converse prompt includes sk-first product-help facts", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    expect(p).toContain("/openapi.json");
    expect(p).toContain("/docs");
    expect(p).toContain("sk mcp");
    expect(p).toContain("Google Chat is a first-class chat adapter");
    expect(p).toContain("tenant.create_schedule");
    expect(p).toContain("every:<seconds>");
    expect(p).toContain("/permissions");
  });
});
