// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` tokens are part of the tested grammar.
// An authoring step answers only for the step references it introduces.
//
// The expressions are the production ones that triggered this: shared transform
// code that reads a step of a sibling workflow behind a test on ANOTHER step, so
// no guard-syntax heuristic could ever clear them.

import { expect, test } from "bun:test";
import {
  partitionStepReferences,
  validateStepReferences,
  validateUnsupportedPlaceholders,
} from "../reference-validator.ts";
import type { WorkflowDef } from "../types.ts";

const PLAN =
  "const current = input.scope.rollup_window\n  ? input.scope.rollup_window.data\n  : input.scope.window.data;\nreturn current;";

function def(steps: Array<Record<string, unknown>>): WorkflowDef {
  return { name: "rollup", steps } as unknown as WorkflowDef;
}
const base = () => [
  { id: "rollup_window", kind: "transform", expression: "return {};" },
  { id: "comparison_plan", kind: "transform", expression: PLAN },
];
const dangling = (steps: Array<Record<string, unknown>>) => validateStepReferences(def(steps));

test("the else-branch read of an absent step is inherited, not introduced", () => {
  const baseline = dangling(base());
  expect(baseline.map((e) => e.bad_reference)).toEqual(["window"]);
  const withField = base().map((s) => (s.id === "rollup_window" ? { ...s, timeout_ms: 5 } : s));
  const split = partitionStepReferences(dangling(withField), baseline);
  expect(split.introduced).toEqual([]);
  expect(split.inherited.map((e) => e.bad_reference)).toEqual(["window"]);
});

test("the same absent step read from ANOTHER step is introduced", () => {
  const next = [
    ...base(),
    { id: "extra", kind: "transform", expression: "return input.scope.window.data.length;" },
  ];
  const split = partitionStepReferences(dangling(next), dangling(base()));
  expect(split.introduced.map((e) => e.step_id)).toEqual(["extra"]);
  expect(split.inherited.map((e) => e.step_id)).toEqual(["comparison_plan"]);
});

test("renaming the step, or editing its expression while keeping the read, stays inherited", () => {
  const renamed = base().map((s) => (s.id === "comparison_plan" ? { ...s, id: "plan" } : s));
  expect(partitionStepReferences(dangling(renamed), dangling(base())).introduced).toEqual([]);
  const edited = base().map((s) =>
    s.id === "comparison_plan" ? { ...s, expression: `${PLAN}\n// reviewed` } : s,
  );
  expect(partitionStepReferences(dangling(edited), dangling(base())).introduced).toEqual([]);
});

test("removing a step others still name is introduced by the removal", () => {
  const baseline = dangling(base());
  // An UNGUARDED reader is what makes a removal an error. The reader that
  // tests for the step first has already said the step may be absent, so its
  // removal takes the branch that reader wrote for exactly this case — see
  // reference-validator-guarded.test.ts.
  const withReader = [
    ...base(),
    { id: "reader", kind: "transform", expression: "return input.scope.rollup_window.data;" },
  ];
  const removed = withReader.filter((s) => s.id !== "rollup_window");
  const split = partitionStepReferences(dangling(removed), dangling(withReader));
  expect(split.introduced.map((e) => e.bad_reference)).toContain("rollup_window");
  expect(split.introduced.map((e) => e.step_id)).toEqual(["reader"]);
  // With only the guarded reader left, the removal blocks nothing new.
  const guardedOnly = base().filter((s) => s.id !== "rollup_window");
  expect(partitionStepReferences(dangling(guardedOnly), baseline).introduced).toEqual([]);
});

test("with nothing to inherit from, every dangling reference is introduced", () => {
  const split = partitionStepReferences(dangling(base()), []);
  expect(split.inherited).toEqual([]);
  expect(split.introduced.map((e) => e.bad_reference)).toEqual(["window"]);
});

// A JavaScript selector is not a placeholder site. The linter already holds out
// `transform.expression` for this reason; the generic per-step walk put the bug
// back for `for_each`, and its suggestion (`${scope.sourceData…}`) would have
// broken a selector that runs in production.
test("a template literal in a for_each or data_selector is not an unsupported placeholder", () => {
  const withSelectors = def([
    {
      id: "ingest",
      kind: "request",
      method: "POST",
      url: "https://api.example.test/ingest",
      for_each:
        "(sourceData) => sourceData.build.data.publish ? [{title:`state ${sourceData.window.data.start}`}] : []",
      data_selector: "(out) => ({ id: `${out.id}` })",
    },
  ]);
  expect(validateUnsupportedPlaceholders(withSelectors)).toEqual([]);
  // A placeholder in a field the runtime DOES substitute is still reported.
  const withBadBody = def([
    {
      id: "ingest",
      kind: "request",
      method: "POST",
      url: "https://api.example.test/ingest",
      body: { title: "${sourceData.window.data.start}" },
    },
  ]);
  expect(validateUnsupportedPlaceholders(withBadBody).map((e) => e.code)).toEqual(["bad_kind"]);
});
