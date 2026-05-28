// Guards the WORKFLOW STEP KINDS behaviour skill body + the cleanup /
// product-help skill body. Without the kind enumeration the model
// invents Zapier-style namespaces (`trigger.manual` / `flow.approval`)
// that propose_step rejects, causing self-reinforcing tool failures.
// Without the cleanup section the model falls back to "this isn't
// supported" prose for delete_workflow / revoke_api_key requests.
//
// `workflow-step-kinds` and `placeholder-rules` are mode-specific
// since the chat execution-UX unification — they ship in workflow /
// connector / diagnosis mode (where the LLM proposes / repairs steps)
// and stay out of execution-mode turns (where the LLM only dispatches
// already-saved workflows). The assertions below cover both code paths.

import { describe, expect, it } from "bun:test";
import { basePromptFor } from "../context-assembler.ts";

// 4.2.0: dropped `tool` (docker-based sandbox retired; subkit is a
// data-workflow engine, not a container runtime).
const ALL_KINDS = ["request", "transform", "call", "wait", "branch", "parallel", "loop"] as const;

describe("base prompts — step-kind enumeration + cleanup facts", () => {
  it("converse prompt (sk_interactive, workflow mode) lists all 7 kinds", async () => {
    const p = await basePromptFor("converse", "sk_interactive", {
      mode: "workflow",
      stage: "workflow_draft_started" as const,
      lifecycle_state: "draft_only" as const,
      active_target: { kind: "workflow" as const, lifecycle_state: "draft_only" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    for (const k of ALL_KINDS) {
      expect(p).toContain(`\`${k}\``);
    }
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("propose_step");
  });

  it("converse prompt (mcp, connector mode) lists all 7 kinds", async () => {
    const p = await basePromptFor("converse", "mcp", {
      mode: "connector",
      stage: "connector_draft_started" as const,
      lifecycle_state: "draft_only" as const,
      active_target: { kind: "connector" as const, lifecycle_state: "draft_only" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    for (const k of ALL_KINDS) expect(p).toContain(`\`${k}\``);
  });

  it("converse prompt (execution mode) does NOT inline the step-kinds skill", async () => {
    const p = await basePromptFor("converse", "sk_interactive", {
      mode: "execution",
      stage: "workflow_persisted" as const,
      lifecycle_state: "persisted" as const,
      active_target: { kind: "workflow" as const, lifecycle_state: "persisted" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    expect(p).not.toContain("WORKFLOW STEP KINDS");
  });

  it("converse prompt (execution mode) does NOT inline placeholder-rules", async () => {
    // Mode-gated skill trim moved both workflow-step-kinds AND
    // placeholder-rules out of always-loaded. An execution-mode turn
    // must NOT carry the `${cred|connector|input|scope.*}` grammar so
    // the token saving is real.
    const p = await basePromptFor("converse", "sk_interactive", {
      mode: "execution",
      stage: "workflow_persisted" as const,
      lifecycle_state: "persisted" as const,
      active_target: { kind: "workflow" as const, lifecycle_state: "persisted" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    expect(p).not.toContain("PLACEHOLDER RULES");
    // Defence-in-depth: the placeholder grammar's anchor phrases must
    // also be absent. A future split of the skill body that keeps the
    // grammar but renames the header would otherwise sneak through.
    expect(p).not.toContain("${cred:");
    expect(p).not.toContain("${connector.");
  });

  it("converse prompt (diagnosis mode) still loads BOTH step-kinds AND placeholder-rules", async () => {
    // Diagnosis-mode turns can still propose / patch steps in response
    // to an execution failure — the anti-Zapier-namespace floor must
    // stay loaded so the model never invents `type` / `trigger.*`.
    const p = await basePromptFor("converse", "sk_interactive", {
      mode: "diagnosis",
      stage: "diagnosing" as const,
      lifecycle_state: "persisted" as const,
      active_target: { kind: "workflow" as const, lifecycle_state: "persisted" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("PLACEHOLDER RULES");
  });

  it("generate prompt lists all 7 kinds", async () => {
    const p = await basePromptFor("generate");
    for (const k of ALL_KINDS) expect(p).toContain(k);
  });

  it("generate prompt does NOT mention the retired `tool` kind", async () => {
    const p = await basePromptFor("generate");
    // Single bare-word match — "tool" appears in unrelated phrases like
    // "tool calling", so anchor to the kinds-list comma sequence.
    expect(p).not.toContain("loop, tool");
  });

  it("converse prompt (workflow mode) warns against the wrong discriminator key", async () => {
    const p = await basePromptFor("converse", "sk_interactive", {
      mode: "workflow",
      stage: "workflow_draft_started" as const,
      lifecycle_state: "draft_only" as const,
      active_target: { kind: "workflow" as const, lifecycle_state: "draft_only" as const },
      blocked_by: [],
      next_required_action: null,
      next_suggested_tool: null,
      checkpoints: [],
      latest_execution: null,
      latest_diagnosis: null,
    });
    expect(p).toContain("never `type`");
  });

  it("converse prompt (any mode) grounds cleanup actions to explicit tools only", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    expect(p).toContain("delete_workflow");
    expect(p).toContain("revoke_api_key");
    expect(p).toContain("Do NOT invent a UI");
    expect(p).toContain("There is no generic Subkit web UI/dashboard");
  });

  it("converse prompt (any mode) includes sk-first product-help facts", async () => {
    const p = await basePromptFor("converse", "sk_interactive");
    expect(p).toContain("/openapi.json");
    expect(p).toContain("/docs");
    expect(p).toContain("sk mcp");
    expect(p).toContain("Google Chat is a first-class chat adapter");
    expect(p).toContain("tenant_create_schedule");
    expect(p).toContain("every:<seconds>");
    expect(p).toContain("/permissions");
  });
});
