import { expect, test } from "bun:test";
import { parsePruneVerificationRunsArgs } from "../prune-verification-runs.ts";

test("verification-run pruning defaults to preview and requires an explicit apply flag", () => {
  expect(parsePruneVerificationRunsArgs([])).toEqual({ apply: false });
  expect(parsePruneVerificationRunsArgs(["--preview"])).toEqual({ apply: false });
  expect(parsePruneVerificationRunsArgs(["--apply"])).toEqual({ apply: true });
  expect(() => parsePruneVerificationRunsArgs(["--root", "/tmp"])).toThrow("usage:");
});
