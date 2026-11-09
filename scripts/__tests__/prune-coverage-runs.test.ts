import { describe, expect, test } from "bun:test";
import { parsePruneCoverageRunsArgs } from "../prune-coverage-runs.ts";

describe("prune coverage runs arguments", () => {
  test("defaults to preview and requires explicit apply", () => {
    expect(parsePruneCoverageRunsArgs([])).toBe(false);
    expect(parsePruneCoverageRunsArgs(["--preview"])).toBe(false);
    expect(parsePruneCoverageRunsArgs(["--apply"])).toBe(true);
    expect(() => parsePruneCoverageRunsArgs(["--delete"])).toThrow();
  });
});
