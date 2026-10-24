import { describe, expect, test } from "bun:test";
import {
  planSkillLoads,
  singleSkillNeeds,
  visibleLoads,
} from "../validators/authoring-prompt-size-per-step.ts";

describe("skill load results carried per authoring chat step", () => {
  test("a load result stays in the current and the two previous user turns", () => {
    const loads = [
      { slug: "core", turn: 1 },
      { slug: "topic", turn: 3 },
    ];
    expect(visibleLoads(loads, 1, 3).map((load) => load.slug)).toEqual(["core"]);
    expect(visibleLoads(loads, 3, 3).map((load) => load.slug)).toEqual(["core", "topic"]);
    expect(visibleLoads(loads, 4, 3).map((load) => load.slug)).toEqual(["topic"]);
    expect(visibleLoads(loads, 6, 3)).toEqual([]);
  });

  test("a needed skill is loaded again only after its last result left the window", () => {
    expect(
      planSkillLoads([["core"], ["core"], ["core", "topic"], ["core"], ["core"], ["core"]], 3),
    ).toEqual([
      { slug: "core", turn: 1 },
      { slug: "topic", turn: 3 },
      { slug: "core", turn: 4 },
    ]);
  });

  test("the single-skill arm needs the merged skill wherever the split needs a family member", () => {
    expect(
      singleSkillNeeds(
        ["workflow-authoring", "workflow-authoring-repair", "data-handling"],
        "workflow-authoring",
        "workflow-authoring",
      ),
    ).toEqual(["workflow-authoring", "data-handling"]);
  });
});
