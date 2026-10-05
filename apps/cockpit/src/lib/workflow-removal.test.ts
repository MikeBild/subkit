import { expect, test } from "bun:test";
import { removalConsequenceKeys } from "./workflow-removal";

test("a workflow started only on request names neither webhook nor schedule", () => {
  expect(removalConsequenceKeys("delete", { webhook: false, schedule: false })).toEqual([
    "workflowPage.deleteConsequence.base",
  ]);
  expect(removalConsequenceKeys("disable", { webhook: false, schedule: false })).toEqual([
    "workflowPage.disableConsequence.base",
  ]);
});

test("each starter the workflow has is named, and only those", () => {
  expect(removalConsequenceKeys("delete", { webhook: true, schedule: false })).toEqual([
    "workflowPage.deleteConsequence.webhook",
    "workflowPage.deleteConsequence.base",
  ]);
  expect(removalConsequenceKeys("disable", { webhook: true, schedule: true })).toEqual([
    "workflowPage.disableConsequence.base",
    "workflowPage.disableConsequence.webhook",
    "workflowPage.disableConsequence.schedule",
  ]);
});
