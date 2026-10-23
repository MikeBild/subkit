import { describe, expect, test } from "bun:test";

import { loadEmbeddedSkillSeeds } from "../../../../skills/seed.ts";
import {
  AUTHORING_ONLY_TAG,
  autoloadForDiagnoses,
  autoloadForToolCall,
  autoloadForUserTurn,
} from "../../../skill-autoload.ts";

const seeds = loadEmbeddedSkillSeeds();
const family = seeds.skills.filter((skill) => skill.slug.startsWith("workflow-authoring"));
const core = family.find((skill) => skill.slug === "workflow-authoring");
const topics = family.filter((skill) => skill.slug !== "workflow-authoring");

describe("workflow-authoring core and topic skills", () => {
  test("the core recipe stays within its context budget", () => {
    expect(seeds.errors).toEqual([]);
    expect(core).toBeDefined();
    expect(core?.body.length ?? Infinity).toBeLessThanOrEqual(15_000);
  });

  test("every topic skill is a stable, visible global skill with its own activation rules", () => {
    expect(topics.length).toBeGreaterThanOrEqual(10);
    for (const skill of topics) {
      expect(skill.scope).toBe("global");
      expect(skill.maturity).toBe("stable");
      expect(skill.tags).not.toContain(AUTHORING_ONLY_TAG);
      expect(skill.activates_when.length).toBeGreaterThan(0);
      expect(skill.activates_when.some((rule) => rule.kind === "baseline")).toBe(false);
      expect(core?.body).not.toContain(skill.body.slice(0, 200));
    }
  });

  test("the core names the topic skills so they can be loaded on demand", () => {
    expect(core?.body).toContain("`workflow-authoring-*`");
  });

  test("a loop step in a patch loads the structures skill next to the core", () => {
    const loaded = autoloadForToolCall(
      {
        tool: "edit_workflow_patch",
        input: { patches: [{ op: "add", path: "/steps/-", value: { id: "each", kind: "loop" } }] },
      },
      seeds.skills,
      [],
    );
    expect(loaded).toContain("workflow-authoring");
    expect(loaded).toContain("workflow-authoring-structures");
    expect(loaded).toContain("workflow-authoring-repair");
    expect(loaded).not.toContain("workflow-authoring-transactional-mail");
  });

  test("a transform step in a patch loads the transforms skill", () => {
    const loaded = autoloadForToolCall(
      {
        tool: "edit_workflow_patch",
        input: {
          patches: [{ op: "add", path: "/steps/-", value: { id: "t", kind: "transform" } }],
        },
      },
      seeds.skills,
      ["workflow-authoring"],
    );
    expect(loaded).toContain("workflow-authoring-transforms");
  });

  test("an unbounded effect diagnosis loads the boundaries skill", () => {
    for (const code of ["dynamic_request", "destructive_effect"]) {
      expect(autoloadForDiagnoses([code], seeds.skills, ["workflow-authoring"])).toContain(
        "workflow-authoring-boundaries",
      );
    }
  });

  test("schedule tools keep loading the core and add schedules and automation readiness", () => {
    const loaded = autoloadForToolCall({ tool: "list_schedules", input: {} }, seeds.skills, []);
    expect(loaded).toContain("workflow-authoring");
    expect(loaded).toContain("workflow-authoring-schedules");
    expect(loaded).toContain("workflow-authoring-automation");
    expect(
      autoloadForToolCall({ tool: "run_workflow", input: {} }, seeds.skills, [
        "workflow-authoring",
      ]),
    ).toContain("workflow-authoring-automation");
  });

  test("goal phrasing loads only the topic it names", () => {
    const turn = (user_text: string) =>
      autoloadForUserTurn({ user_text, first_turn: false, surface: "cockpit" }, seeds.skills, []);
    expect(turn("Return the ranking as a markdown table")).toContain(
      "workflow-authoring-output-format",
    );
    expect(turn("Send the report täglich um 18 Uhr")).toContain("workflow-authoring-schedules");
    expect(turn("Store the reservation in Supabase for the caller")).toContain(
      "workflow-authoring-product-callers",
    );
    expect(turn("Reply with a transactional confirmation email")).toContain(
      "workflow-authoring-transactional-mail",
    );
    const plain = turn("Erstelle einen neuen Workflow für den Tagesbericht");
    expect(plain).toContain("workflow-authoring");
    expect(plain).not.toContain("workflow-authoring-structures");
    expect(plain).not.toContain("workflow-authoring-boundaries");
    expect(plain).not.toContain("workflow-authoring-loop-examples");
  });

  test("a Supabase connector loads the product caller skill", () => {
    expect(
      autoloadForToolCall(
        { tool: "author_workflow", input: {}, connector_templates: ["supabase"] },
        seeds.skills,
        ["workflow-authoring"],
      ),
    ).toContain("workflow-authoring-product-callers");
  });
});
