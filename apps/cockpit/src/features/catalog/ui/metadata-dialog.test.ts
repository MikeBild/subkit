import { expect, test } from "bun:test";
import { workflowEditPatch } from "./metadata-dialog";

const record = { name: "Briefing", description: "Old", category: "devops" };

test("one edit saves name, description and category together and only what changed", () => {
  expect(
    workflowEditPatch(record, { name: "Briefing", description: "Old", category: "devops" }),
  ).toBeNull();
  expect(
    workflowEditPatch(record, { name: " Daily briefing ", description: "Old", category: "devops" }),
  ).toEqual({ name: "Daily briefing" });
  expect(
    workflowEditPatch(record, { name: "Briefing", description: "New", category: "analytics" }),
  ).toEqual({ description: "New", category: "analytics" });
});

test("a workflow never loses its name", () => {
  expect(
    workflowEditPatch(record, { name: "  ", description: "New", category: "devops" }),
  ).toBeNull();
});
