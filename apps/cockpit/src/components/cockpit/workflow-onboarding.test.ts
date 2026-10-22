import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { workflowStartSteps } from "./workflow-onboarding";

const t = (key: Parameters<typeof translate>[1]) => translate("de", key);

test("the start checklist only ticks steps the workspace has really done", () => {
  const fresh = workflowStartSteps(t, { connectors: 0, workflows: 0 });
  expect(fresh.map((step) => step.done)).toEqual([false, false, false, false]);
  expect(fresh[0]?.href).toBe("/connectors");
  const connected = workflowStartSteps(t, { connectors: 2, workflows: 0 });
  expect(connected.map((step) => step.done)).toEqual([true, false, false, false]);
  expect(connected.every((step) => step.title.length > 0 && step.line.length > 0)).toBe(true);
});
