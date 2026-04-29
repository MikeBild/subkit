// Mode-aware agent skill loading helper (#24). Today every behaviour
// skill body is pinned as a conversation-wide invariant by other
// tests (agent-registry + base-prompt-step-kinds), so the helper
// returns ALL_AGENT_SKILLS regardless of mode. The infrastructure
// stays wired so a future split (when one of the 10 bodies stops
// being load-bearing) is a one-line change to MODE_SPECIFIC_AGENT_SKILLS.

import { describe, expect, test } from "bun:test";
import {
  ALL_AGENT_SKILLS,
  ALWAYS_LOADED_AGENT_SKILLS,
  resolveAgentSkillsForMode,
} from "./index.ts";

describe("resolveAgentSkillsForMode", () => {
  test("ALWAYS_LOADED_AGENT_SKILLS currently equals ALL_AGENT_SKILLS", () => {
    expect([...ALWAYS_LOADED_AGENT_SKILLS].sort()).toEqual([...ALL_AGENT_SKILLS].sort());
  });

  test("null mode returns the always-loaded core", () => {
    const skills = resolveAgentSkillsForMode(null);
    expect(skills.length).toBe(ALWAYS_LOADED_AGENT_SKILLS.length);
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("undefined mode = null mode", () => {
    expect(resolveAgentSkillsForMode(undefined)).toEqual(resolveAgentSkillsForMode(null));
  });

  test("workflow mode includes the always-loaded core (currently the same set)", () => {
    const skills = resolveAgentSkillsForMode("workflow");
    expect(skills).toContain("workflow-step-kinds");
    expect(skills).toContain("placeholder-rules");
    expect(skills).toContain("conversational-authoring");
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("connector / execution / diagnosis modes match the same always-loaded core", () => {
    for (const mode of ["connector", "execution", "diagnosis"]) {
      const skills = resolveAgentSkillsForMode(mode);
      expect([...skills].sort()).toEqual([...ALL_AGENT_SKILLS].sort());
    }
  });

  test("returned order matches AGENT_SKILL_NAMES canonical order", () => {
    const skills = resolveAgentSkillsForMode("workflow");
    const indices = skills.map((s) => ALL_AGENT_SKILLS.indexOf(s));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });
});
