// Locks the agent-registry shape: the MAIN agent must preload the
// behaviour skills and its system-prompt generator must produce a
// non-empty body containing the persona + every preloaded skill.

import { describe, expect, it } from "bun:test";
import type { AuthoringPromptHint } from "../../../llm/types.ts";
import type { AuthoringSurfaceMode } from "../../types.ts";
import { AGENT_REGISTRY, AgentType, getAgent } from "../registry.ts";
import { ALL_AGENT_SKILLS } from "../skills/index.ts";

function makeHint(mode: AuthoringSurfaceMode): AuthoringPromptHint {
  return {
    mode,
    stage: "idle",
    lifecycle_state: "draft_only",
    active_target: { kind: "workflow", lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

describe("agent registry — MAIN", () => {
  it("registers MAIN with every behaviour skill preloaded", () => {
    const main = getAgent(AgentType.MAIN);
    expect(main.id).toBe("main");
    expect([...main.preloadedSkills].sort()).toEqual([...ALL_AGENT_SKILLS].sort());
  });

  it("exposes a single agent today", () => {
    expect(Object.keys(AGENT_REGISTRY)).toEqual(["main"]);
  });

  it("generates a default system prompt with the always-loaded skill bodies", async () => {
    const main = getAgent(AgentType.MAIN);
    const result = await main.systemPromptGenerator({ surface: "sk_interactive" });
    expect(result.content).toContain("subkit's authoring + operator assistant");
    expect(result.content).toContain("GENERAL RULES:");
    expect(result.content).toContain("SKILL LOADING:");
    // Always-loaded skill bodies — present regardless of mode.
    expect(result.content).toContain("CHAT-FIRST CONTRACT");
    expect(result.content).toContain("SINGLE-CONFIRMATION RULE");
    expect(result.content).toContain("PERMISSION-MODE-AWARE CONFIRMATION");
    expect(result.content).toContain("TURN RHYTHM");
    expect(result.content).toContain("TURN-ONE DISCIPLINE");
    expect(result.content).toContain("USER-LANGUAGE MIRRORING");
    expect(result.content).toContain("ATTACHMENT HANDLING");
    expect(result.content).toContain("PLACEHOLDER RULES");
    expect(result.content).toContain("WORKFLOW STEP KINDS");
    expect(result.content).toContain("ERROR RECOVERY:");
    expect(result.content).toContain("ACCESS RULES (RBAC):");
    // conversational-authoring is mode-specific (workflow / connector
    // only) so it must NOT appear in a default-mode prompt.
    expect(result.content).not.toContain("CONVERSATIONAL AUTHORING:");
  });

  it("workflow-mode prompt adds the conversational-authoring body", async () => {
    const main = getAgent(AgentType.MAIN);
    const result = await main.systemPromptGenerator({
      surface: "sk_interactive",
      authoring_hint: makeHint("workflow"),
    });
    expect(result.content).toContain("CONVERSATIONAL AUTHORING:");
  });

  it("connector-mode prompt adds the conversational-authoring body", async () => {
    const main = getAgent(AgentType.MAIN);
    const result = await main.systemPromptGenerator({
      surface: "sk_interactive",
      authoring_hint: makeHint("connector"),
    });
    expect(result.content).toContain("CONVERSATIONAL AUTHORING:");
  });

  it("execution-mode prompt does not add the conversational-authoring body", async () => {
    const main = getAgent(AgentType.MAIN);
    const result = await main.systemPromptGenerator({
      surface: "sk_interactive",
      authoring_hint: makeHint("execution"),
    });
    expect(result.content).not.toContain("CONVERSATIONAL AUTHORING:");
  });

  it("threads surface verbosity into the prompt", async () => {
    const headless = await getAgent(AgentType.MAIN).systemPromptGenerator({
      surface: "sk_headless",
    });
    expect(headless.content).toContain("Respond tersely");
    const mcp = await getAgent(AgentType.MAIN).systemPromptGenerator({ surface: "mcp" });
    expect(mcp.content).toContain("external MCP client");
  });

  it("throws on unknown agent ids", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass enum
    expect(() => getAgent("does-not-exist" as any)).toThrow(/Unknown agent/);
  });
});
