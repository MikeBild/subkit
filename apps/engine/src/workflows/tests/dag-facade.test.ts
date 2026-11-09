import { expect, test } from "bun:test";
import * as core from "../core/dag.ts";
import * as facade from "../dag.ts";

test("the legacy workflow DAG facade preserves the core public API", () => {
  expect(facade.buildStepDag).toBe(core.buildStepDag);
  expect(facade.detectCycles).toBe(core.detectCycles);
  expect(facade.topoSort).toBe(core.topoSort);
  expect(facade.renderCycleReport).toBe(core.renderCycleReport);
});
