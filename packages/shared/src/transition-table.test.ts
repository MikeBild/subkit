import { describe, expect, test } from "bun:test";
import { canTransitionIn, type TransitionTable, transitionSourcesIn } from "./transition-table.ts";

type Light = "red" | "green" | "yellow";

const LIGHT: TransitionTable<Light> = {
  red: ["green"],
  green: ["yellow"],
  yellow: ["red", "yellow"],
};

describe("canTransitionIn", () => {
  test("allows only the moves listed for the source status", () => {
    expect(canTransitionIn(LIGHT, "red", "green")).toBe(true);
    expect(canTransitionIn(LIGHT, "red", "yellow")).toBe(false);
    expect(canTransitionIn(LIGHT, "yellow", "yellow")).toBe(true);
  });
});

describe("transitionSourcesIn", () => {
  test("lists every status that may reach the target", () => {
    expect(transitionSourcesIn(LIGHT, "red")).toEqual(["yellow"]);
    expect(transitionSourcesIn(LIGHT, "yellow")).toEqual(["green", "yellow"]);
  });

  test("narrows an allowed list to the legal sources", () => {
    expect(transitionSourcesIn(LIGHT, "yellow", ["red", "yellow"])).toEqual(["yellow"]);
    expect(transitionSourcesIn(LIGHT, "green", ["green"])).toEqual([]);
  });
});
