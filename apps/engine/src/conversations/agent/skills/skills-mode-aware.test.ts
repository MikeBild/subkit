// Mode-aware agent skill loading helper. Three behaviour bodies are
// mode-specific: `conversational-authoring` (the ideal-flow narrative),
// `workflow-step-kinds` (the no-invented-dotted-namespace step kind floor),
// `placeholder-rules` (the `${cred|connector|input|scope.*}` grammar).
// Execution-mode turns ("run <slug>") reach for `wf_<slug>` /
// `run_workflow` and never propose steps, so trimming the latter two
// saves ~750 tokens per turn. Authoring (workflow / connector) and
// diagnosis modes re-add them.

import { describe, expect, test } from "bun:test";
import {
  ALL_AGENT_SKILLS,
  ALWAYS_LOADED_AGENT_SKILLS,
  loadAgentSkills,
  MODE_SPECIFIC_AGENT_SKILLS,
  resolveAgentSkillsForMode,
} from "./index.ts";

const MODE_GATED = [
  "conversational-authoring",
  "workflow-step-kinds",
  "placeholder-rules",
] as const;

describe("resolveAgentSkillsForMode", () => {
  test("ALWAYS_LOADED_AGENT_SKILLS excludes mode-gated skills", () => {
    for (const gated of MODE_GATED) {
      expect(ALWAYS_LOADED_AGENT_SKILLS).not.toContain(gated);
    }
    for (const name of ALL_AGENT_SKILLS) {
      if ((MODE_GATED as ReadonlyArray<string>).includes(name)) continue;
      expect(ALWAYS_LOADED_AGENT_SKILLS).toContain(name);
    }
  });

  test("null mode returns exactly the always-loaded core", () => {
    const skills = resolveAgentSkillsForMode(null);
    expect(skills.length).toBe(ALWAYS_LOADED_AGENT_SKILLS.length);
    for (const gated of MODE_GATED) expect(skills).not.toContain(gated);
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("undefined mode = null mode", () => {
    expect(resolveAgentSkillsForMode(undefined)).toEqual(resolveAgentSkillsForMode(null));
  });

  test("workflow mode adds conversational-authoring + step-kinds + placeholders", () => {
    const skills = resolveAgentSkillsForMode("workflow");
    for (const gated of MODE_GATED) expect(skills).toContain(gated);
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("connector mode adds conversational-authoring + step-kinds + placeholders", () => {
    const skills = resolveAgentSkillsForMode("connector");
    for (const gated of MODE_GATED) expect(skills).toContain(gated);
    for (const s of ALWAYS_LOADED_AGENT_SKILLS) expect(skills).toContain(s);
  });

  test("diagnosis mode adds step-kinds + placeholders but not conversational-authoring", () => {
    const skills = resolveAgentSkillsForMode("diagnosis");
    expect(skills).toContain("workflow-step-kinds");
    expect(skills).toContain("placeholder-rules");
    expect(skills).not.toContain("conversational-authoring");
  });

  test("execution mode loads exactly the always-loaded core (no mode-gated skills)", () => {
    const skills = resolveAgentSkillsForMode("execution");
    for (const gated of MODE_GATED) expect(skills).not.toContain(gated);
    expect([...skills].sort()).toEqual([...ALWAYS_LOADED_AGENT_SKILLS].sort());
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

describe("skill content pinning — turn-one-discipline phrases (6.2.12 regression guard)", () => {
  // Pins the SAVED-WORKFLOW-BEFORE-AD-HOC-CALL rule introduced in 6.2.12.
  // The agent was guessing REST/GraphQL endpoints before checking the
  // tenant's saved workflows, wasting two turns in the May 2026 OCPP
  // review session. The turn-one-discipline skill now carries an explicit
  // rule; these tests ensure the content is never accidentally trimmed.
  const bundle = loadAgentSkills(ALWAYS_LOADED_AGENT_SKILLS);

  test('bundle contains the literal phrase "SAVED WORKFLOW BEFORE AD-HOC CALL"', () => {
    expect(bundle).toContain("SAVED WORKFLOW BEFORE AD-HOC CALL");
  });

  test('bundle references "run_workflow" (the tool the skill points the agent at)', () => {
    expect(bundle).toContain("run_workflow");
  });

  test('bundle contains "do not speculate about API endpoints" prohibition', () => {
    expect(bundle).toContain("do not speculate about API endpoints");
  });
});

describe("attachment-handling skill content", () => {
  // Pins the regression fix for the "create a knowledge source using
  // /Users/...md" flow: the agent was hallucinating a paperclip UI,
  // pointing at the half-right /attach path, and bouncing users to a
  // slash command they then had to copy-paste. sk now auto-uploads
  // any absolute local path mentioned in a natural-language prompt;
  // the skill must teach the agent to expect a {"$file":"fid_…"}
  // leaf in those prompts and call `mode='from_attachment'` directly.
  const bundle = loadAgentSkills(ALWAYS_LOADED_AGENT_SKILLS);

  test("loaded bundle still references the /knowledge <path> slash as the explicit surface", () => {
    expect(bundle).toContain("/knowledge <path>");
  });

  test("loaded bundle forbids inventing a paperclip / drag-drop UI", () => {
    expect(bundle).toContain("paperclip");
    expect(bundle).toMatch(/no paperclip/i);
  });

  test("loaded bundle says the engine cannot read local filesystem paths", () => {
    expect(bundle).toContain("cannot read local filesystem paths");
  });

  test("loaded bundle teaches that sk auto-uploads local paths before the agent reads them", () => {
    // The prose may say "auto-uploads" or "auto-upload" — both mean
    // the preprocessor in apps/sk/src/lib/path-preprocessor.ts ran
    // before the agent saw the prompt.
    expect(bundle).toMatch(/auto-uploads?/i);
  });

  test("loaded bundle teaches mode='from_attachment' when a $file leaf is present", () => {
    expect(bundle).toContain("mode='from_attachment'");
  });
});
