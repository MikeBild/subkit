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
    expect(core?.body.length ?? Infinity).toBeLessThanOrEqual(21_000);
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
    expect(core?.body).toContain("reach you only through `load_skill`");
  });

  test("the core carries the sensitive execution rules every preview and save needs", () => {
    const sensitive = core?.body.split("## Sensitive execution\n")[1]?.split("\n## ")[0] ?? "";
    expect(sensitive).toContain('`execution_privacy: "sensitive"` is an explicit opt-in');
    expect(sensitive).toContain("returns metadata only");
    expect(sensitive).toContain("do not guess, describe or reconstruct them");
    expect(sensitive).toContain('`mode: "schema_only"` checks structure only');
    expect(sensitive).toContain("a failed check blocks the save and cannot be forced");
    for (const topic of topics) expect(topic.body).not.toContain("returns metadata only");
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

  test("preview and save keep the core recipe and add only the save rules", () => {
    const preview = autoloadForToolCall({ tool: "dry_run_workflow", input: {} }, seeds.skills, []);
    expect(preview).toContain("workflow-authoring");
    expect(preview).not.toContain("workflow-authoring-repair");
    expect(preview).not.toContain("workflow-authoring-structures");
    const save = autoloadForToolCall({ tool: "save_workflow_draft", input: {} }, seeds.skills, []);
    expect(save).toContain("workflow-authoring");
    expect(save).toContain("workflow-authoring-automation");
    expect(save).not.toContain("workflow-authoring-repair");
    const automation = topics.find((skill) => skill.slug === "workflow-authoring-automation");
    expect(automation?.body).toContain(
      "**Calling `save_workflow_draft` after a green `dry_run_workflow`.**",
    );
  });

  test("a for_each patch loads the structures skill", () => {
    const loaded = autoloadForToolCall(
      {
        tool: "edit_workflow_patch",
        input: {
          step_patches: [
            { step_id: "send", op: "add", path: "/for_each", value: { items: "x", as: "m" } },
          ],
        },
      },
      seeds.skills,
      ["workflow-authoring"],
    );
    expect(loaded).toContain("workflow-authoring-structures");
  });

  test("an S3 connector in scope loads the product S3 caller rules", () => {
    const loaded = autoloadForToolCall(
      { tool: "author_workflow", input: {}, connector_drivers: ["s3"] },
      seeds.skills,
      ["workflow-authoring"],
    );
    expect(loaded).toContain("workflow-authoring-product-callers");
    const productCallers = topics.find(
      (skill) => skill.slug === "workflow-authoring-product-callers",
    );
    expect(productCallers?.body).toContain("principal_bound: true");
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
