import { expect, test } from "bun:test";
import { workflowStepChanges } from "./workflow-step-changes";

test("reports the saved net changes without counting inserted positions as moves", () => {
  const before = [
    { id: "fetch", path: "/old" },
    { id: "format", code: "old" },
  ];
  expect(workflowStepChanges(before, [{ id: "prepare" }, { id: "fetch", path: "/new" }])).toEqual({
    added: 1,
    removed: 1,
    changed: 1,
    reordered: false,
  });
  expect(workflowStepChanges(before, [{ id: "prepare" }, ...before])).toEqual({
    added: 1,
    removed: 0,
    changed: 0,
    reordered: false,
  });
});

test("distinguishes reordered steps from content edits and reverted edits", () => {
  const before = [
    { id: "fetch", path: "/resource" },
    { id: "format", code: "output" },
  ];
  expect(workflowStepChanges(before, [...before].reverse())).toEqual({
    added: 0,
    removed: 0,
    changed: 0,
    reordered: true,
  });
  expect(workflowStepChanges(before, structuredClone(before))).toEqual({
    added: 0,
    removed: 0,
    changed: 0,
    reordered: false,
  });
});

test("object key ordering from server normalization is not an edited step", () => {
  const before = [
    { id: "fetch", kind: "request", query: { page: 1, filter: { active: true, label: "a" } } },
  ];
  const after = [
    { query: { filter: { label: "a", active: true }, page: 1 }, kind: "request", id: "fetch" },
  ];
  expect(workflowStepChanges(before, after)).toEqual({
    added: 0,
    removed: 0,
    changed: 0,
    reordered: false,
  });
});
