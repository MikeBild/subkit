import { describe, expect, test } from "bun:test";
import { ELICITATION_TRANSITIONS, elicitationSources } from "./elicitation-status.ts";

describe("elicitation transitions", () => {
  test("only a pending elicitation is decided", () => {
    expect(elicitationSources("resolved")).toEqual(["pending"]);
    expect(elicitationSources("cancelled")).toEqual(["pending"]);
    expect(elicitationSources("timeout")).toEqual(["pending"]);
  });

  test("a decided elicitation never moves again", () => {
    expect(ELICITATION_TRANSITIONS.resolved).toEqual([]);
    expect(ELICITATION_TRANSITIONS.cancelled).toEqual([]);
    expect(ELICITATION_TRANSITIONS.timeout).toEqual([]);
    expect(elicitationSources("pending")).toEqual([]);
  });
});
