import { expect, test } from "bun:test";
import fc from "fast-check";
import { applyAccepted, patchOperations, selectAccepted } from "./patch-operations.ts";

const BEFORE = {
  id: "shape",
  kind: "transform",
  expression: '{\n  "id": data.id,\n  "owner": data.id\n}',
  report_delivery: { kind: "gmail_report", to: "a@example.test", from: "b@example.test" },
  retired: true,
};

const AFTER = {
  id: "shape",
  kind: "transform",
  expression: '{\n  "id": data.result.id,\n  "owner": data.result.id\n}',
  report_delivery: { kind: "gmail_report", to: "c@example.test", from: "b@example.test" },
  data_selector: "data.result",
};

test("one operation per changed path, per line inside a multi-line value", () => {
  expect(patchOperations(BEFORE, AFTER)).toEqual([
    {
      index: 0,
      path: "data_selector",
      line: null,
      change: "added",
      before: null,
      after: "data.result",
      description_key: "patch_operation.data_selector_added",
    },
    {
      index: 1,
      path: "expression",
      line: 2,
      change: "changed",
      before: '  "id": data.id,',
      after: '  "id": data.result.id,',
      description_key: "patch_operation.expression_line_changed",
    },
    {
      index: 2,
      path: "expression",
      line: 3,
      change: "changed",
      before: '  "owner": data.id',
      after: '  "owner": data.result.id',
      description_key: "patch_operation.expression_line_changed",
    },
    {
      index: 3,
      path: "report_delivery.to",
      line: null,
      change: "changed",
      before: "a@example.test",
      after: "c@example.test",
      description_key: "patch_operation.report_delivery_changed",
    },
    {
      index: 4,
      path: "retired",
      line: null,
      change: "removed",
      before: true,
      after: null,
      description_key: "patch_operation.field_removed",
    },
  ]);
});

test("identical steps have no operations; a single-line or reflowed value is one operation", () => {
  expect(patchOperations(BEFORE, structuredClone(BEFORE))).toEqual([]);
  expect(
    patchOperations({ data_selector: "$.data.id" }, { data_selector: "$.data.result.id" }),
  ).toMatchObject([{ index: 0, path: "data_selector", line: null, change: "changed" }]);
  expect(patchOperations({ expression: "a\nb" }, { expression: "a\nb\nc" })).toMatchObject([
    { index: 0, path: "expression", line: null, change: "changed" },
  ]);
});

test("a map with dotted keys and a list change as a whole", () => {
  const operations = patchOperations(
    { headers: { "x.trace": "1", accept: "a" }, tags: ["a"] },
    { headers: { "x.trace": "2", accept: "a" }, tags: ["a", "b"] },
  );
  expect(operations.map((operation) => [operation.path, operation.line])).toEqual([
    ["headers", null],
    ["tags", null],
  ]);
});

test("accepting every operation yields the patched step, accepting none the original", () => {
  const operations = patchOperations(BEFORE, AFTER);
  expect(applyAccepted(BEFORE, operations, [0, 1, 2, 3, 4])).toEqual(AFTER);
  expect(applyAccepted(BEFORE, operations, [])).toEqual(BEFORE);
});

test("a partial acceptance changes exactly the accepted paths and leaves the input untouched", () => {
  const frozen = JSON.stringify(BEFORE);
  const operations = patchOperations(BEFORE, AFTER);
  expect(applyAccepted(BEFORE, operations, [2, 3])).toEqual({
    ...BEFORE,
    expression: '{\n  "id": data.id,\n  "owner": data.result.id\n}',
    report_delivery: { ...BEFORE.report_delivery, to: "c@example.test" },
  });
  expect(applyAccepted(BEFORE, operations, [0, 4])).toEqual({
    id: "shape",
    kind: "transform",
    expression: BEFORE.expression,
    report_delivery: BEFORE.report_delivery,
    data_selector: "data.result",
  });
  expect(JSON.stringify(BEFORE)).toBe(frozen);
});

test("the operations of a partly patched step are the declined ones", () => {
  fc.assert(
    fc.property(fc.subarray([0, 1, 2, 3, 4]), (accepted) => {
      const operations = patchOperations(BEFORE, AFTER);
      const partly = applyAccepted(BEFORE, operations, accepted);
      const rest = patchOperations(partly, AFTER).map((operation) => [
        operation.path,
        operation.line,
      ]);
      const declined = operations
        .filter((operation) => !accepted.includes(operation.index))
        .map((operation) => [operation.path, operation.line]);
      expect(rest).toEqual(declined);
    }),
    { seed: 20261123, numRuns: 64 },
  );
});

test("a selection is every operation by default, sorted when given, refused when invalid", () => {
  const operations = patchOperations(BEFORE, AFTER);
  expect(selectAccepted(operations, undefined)).toEqual({
    indices: [0, 1, 2, 3, 4],
    partial: false,
  });
  expect(selectAccepted(operations, null)).toEqual({ indices: [0, 1, 2, 3, 4], partial: false });
  expect(selectAccepted(operations, [3, 1])).toEqual({ indices: [1, 3], partial: true });
  expect(selectAccepted(operations, [4, 3, 2, 1, 0])).toEqual({
    indices: [0, 1, 2, 3, 4],
    partial: false,
  });
  for (const invalid of [[], [5], [-1], [1, 1], [0.5]])
    expect(selectAccepted(operations, invalid)).toBeNull();
});
