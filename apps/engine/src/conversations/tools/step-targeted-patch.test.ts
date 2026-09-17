import { expect, test } from "bun:test";
import { applyDiffsToConfig } from "../json-patch-apply.ts";
import { resolveStepPatches, StepPatchSchema } from "./step-targeted-patch.ts";

const scope = { key_prefix: "reports/daily/", max_bytes: 1000000 };
const patch = { step_id: "store_report", op: "add" as const, path: "/s3/scope", value: scope };
const store = { id: "store_report", s3: { key: "reports/daily/file.json" } };
test("stable target survives a reordered draft and preserves existing request fields", () => {
  for (const steps of [
    [store, { id: "build" }],
    [{ id: "build" }, store],
  ]) {
    const draft: { steps: Record<string, unknown>[] } = { steps };
    const result = applyDiffsToConfig(draft, resolveStepPatches(steps, [patch]));
    expect(result.steps.find((s) => s.id === "store_report")).toEqual({
      ...store,
      s3: { ...store.s3, scope },
    });
    expect(draft.steps.find((s) => s.id === "store_report")).toEqual(store);
  }
});
test("missing or ambiguous IDs reject the entire batch without guessing a target", () => {
  expect(() => resolveStepPatches([{ id: "other" }], [patch])).toThrow("found 0");
  expect(() => resolveStepPatches([store, store], [patch])).toThrow("found 2");
  expect(() => resolveStepPatches([store], [patch, { ...patch, step_id: "missing" }])).toThrow(
    "found 0",
  );
});
test("relative edits cannot replace the whole workflow or move steps by guessed positions", () => {
  for (const path of ["", "/", "s3/scope", "//steps/0"]) {
    expect(StepPatchSchema.safeParse({ ...patch, path }).success).toBe(false);
  }
  expect(StepPatchSchema.safeParse({ ...patch, op: "move", from: "/steps/0" }).success).toBe(false);
  expect(
    resolveStepPatches([store], [{ step_id: store.id, op: "test", path: "/id", value: store.id }]),
  ).toEqual([{ op: "test", path: "/steps/0/id", value: store.id }]);
});
