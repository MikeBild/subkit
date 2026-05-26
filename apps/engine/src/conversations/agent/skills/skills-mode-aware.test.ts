// Mode-aware agent skill loading helper. The 9-skill always-loaded
// core is pinned by base-prompt-step-kinds + the registry test as a
// minimal anti-Zapier-namespace floor. `conversational-authoring` is
// the only body large enough (~7.3KB) and authoring-specific enough
// to be loaded on demand — workflow / connector authoring modes
// include it; execution / diagnosis / default modes do not.

import { describe, expect, test } from "bun:test";
import {
  ALL_AGENT_SKILLS,
  ALWAYS_LOADED_AGENT_SKILLS,
  loadAgentSkills,
  MODE_SPECIFIC_AGENT_SKILLS,
  resolveAgentSkillsForMode,
} from "./index.ts";

describe("resolveAgentSkillsForMode", () => {
  test("ALWAYS_LOADED_AGENT_SKILLS excludes conversational-authoring", () => {
    expect(ALWAYS_LOADED_AGENT_SKILLS).not.toContain("conversational-authoring");
    // Every other named skill stays universal.
    for (const name of ALL_AGENT_SKILLS) {
      if (name === "conversational-authoring") continue;
      expect(ALWAYS_LOADED_AGENT_SKILLS).toContain(name);
    }
  });

  test("null mode returns exactly the always-loaded core", () => {
    const skills = resolveAgentSkillsForMode(null);
    expect(skills.length).toBe(ALWAYS_LOADED_AGENT_SKILLS.length);
    expect(skills).not.toContain("conversational-authoring");
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("undefined mode = null mode", () => {
    expect(resolveAgentSkillsForMode(undefined)).toEqual(resolveAgentSkillsForMode(null));
  });

  test("workflow mode adds conversational-authoring", () => {
    const skills = resolveAgentSkillsForMode("workflow");
    expect(skills).toContain("conversational-authoring");
    // workflow-step-kinds + placeholder-rules stay in the always-loaded
    // core (anti-Zapier-namespace floor) so they appear here too.
    expect(skills).toContain("workflow-step-kinds");
    expect(skills).toContain("placeholder-rules");
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("connector mode adds conversational-authoring", () => {
    const skills = resolveAgentSkillsForMode("connector");
    expect(skills).toContain("conversational-authoring");
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("execution / diagnosis modes do not add conversational-authoring", () => {
    for (const mode of ["execution", "diagnosis"]) {
      const skills = resolveAgentSkillsForMode(mode);
      expect(skills).not.toContain("conversational-authoring");
      expect([...skills].sort()).toEqual([...ALWAYS_LOADED_AGENT_SKILLS].sort());
    }
  });

  test("MODE_SPECIFIC_AGENT_SKILLS lookup keys cover every authoring mode", () => {
    expect(Object.keys(MODE_SPECIFIC_AGENT_SKILLS).sort()).toEqual([
      "connector",
      "diagnosis",
      "execution",
      "workflow",
    ]);
  });

  test("returned order matches AGENT_SKILL_NAMES canonical order", () => {
    const skills = resolveAgentSkillsForMode("workflow");
    const indices = skills.map((s) => ALL_AGENT_SKILLS.indexOf(s));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });
});

describe("attachment-handling skill content", () => {
  // Pins the regression fix for the "create a knowledge source using
  // /Users/...md" flow: the agent was hallucinating a paperclip UI and
  // pointing at the half-right /attach path. The skill must teach the
  // /knowledge slash and forbid invented UI affordances.
  const bundle = loadAgentSkills(ALWAYS_LOADED_AGENT_SKILLS);

  test("loaded bundle teaches the /knowledge <path> slash", () => {
    expect(bundle).toContain("/knowledge <path>");
  });

  test("loaded bundle forbids inventing a paperclip / drag-drop UI", () => {
    expect(bundle).toContain("paperclip");
    expect(bundle).toMatch(/no paperclip/i);
  });

  test("loaded bundle says the engine cannot read local filesystem paths", () => {
    expect(bundle).toContain("cannot read local filesystem paths");
  });
});
