import { describe, expect, it } from "bun:test";
import { basePromptFor } from "../context-assembler.ts";

const ALL_KINDS = ["request", "transform", "call", "wait", "branch", "parallel"] as const;

describe("base prompts — step-kind enumeration + cleanup facts", () => {
  it("converse prompt (sk_interactive, workflow mode) lists all 6 kinds", async () => {
    const p = (
      await basePromptFor("converse", "sk_interactive", {
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
      })
    ).content;
    for (const k of ALL_KINDS) {
      expect(p).toContain(`\`${k}\``);
    }
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("edit_workflow_patch");
  });

  it("converse prompt (mcp, connector mode) lists all 6 kinds", async () => {
    const p = (
      await basePromptFor("converse", "mcp", {
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
      })
    ).content;
    for (const k of ALL_KINDS) expect(p).toContain(`\`${k}\``);
  });

  it("converse prompt (execution mode) does NOT inline the step-kinds skill", async () => {
    const p = (
      await basePromptFor("converse", "sk_interactive", {
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
      })
    ).content;
    expect(p).not.toContain("WORKFLOW STEP KINDS");
  });

  it("converse prompt (execution mode) does NOT inline placeholder-rules", async () => {
    const p = (
      await basePromptFor("converse", "sk_interactive", {
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
      })
    ).content;
    expect(p).not.toContain("PLACEHOLDER RULES");
    expect(p).not.toContain("${cred:");
    expect(p).not.toContain("${connector.");
  });

  it("converse prompt (diagnosis mode) still loads BOTH step-kinds AND placeholder-rules", async () => {
    const p = (
      await basePromptFor("converse", "sk_interactive", {
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
      })
    ).content;
    expect(p).toContain("WORKFLOW STEP KINDS");
    expect(p).toContain("PLACEHOLDER RULES");
  });

  it("generate prompt lists all 6 kinds", async () => {
    const p = (await basePromptFor("generate")).content;
    for (const k of ALL_KINDS) expect(p).toContain(k);
  });

  it("generate prompt does NOT mention the retired `tool` kind", async () => {
    const p = (await basePromptFor("generate")).content;
    expect(p).not.toContain("parallel, tool");
  });

  it("converse prompt (workflow mode) warns against the wrong discriminator key", async () => {
    const p = (
      await basePromptFor("converse", "sk_interactive", {
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
      })
    ).content;
    expect(p).toContain("never `type`");
  });

  it("converse prompt (any mode) grounds cleanup actions to explicit tools only", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("delete_workflow");
    expect(p).toContain("revoke_api_key");
    expect(p).toContain("Do NOT invent a UI");
    expect(p).toContain("There is no generic Subkit web UI/dashboard");
  });

  it("converse prompt (any mode) includes subkit-first product-help facts", async () => {
    const p = (await basePromptFor("converse", "sk_interactive")).content;
    expect(p).toContain("/openapi.json");
    expect(p).toContain("/docs");
    expect(p).toContain("subkit mcp");
    expect(p).toContain("Google Chat is a first-class chat adapter");
    expect(p).toContain("tenant_create_schedule");
    expect(p).toContain("every:<seconds>");
    expect(p).toContain("/permissions");
  });
});
