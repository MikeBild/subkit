import { describe, expect, test } from "bun:test";
import { stringValue } from "@/components/cockpit/table-columns";
import { workflowsByConnector } from "@/pages/connectors-model";

const workflows = [
  { id: "w1", name: "Monthly report", connectors: ["reporting-api", "mailer"] },
  { id: "w2", name: "Daily digest", connectors: ["mailer"] },
];

describe("connector usage", () => {
  test("a workflow with two connectors appears under both", () => {
    const byConnector = workflowsByConnector(workflows);
    expect(byConnector.get("reporting-api")?.map((workflow) => workflow.name)).toEqual([
      "Monthly report",
    ]);
    expect(byConnector.get("mailer")?.map((workflow) => workflow.name)).toEqual([
      "Monthly report",
      "Daily digest",
    ]);
  });

  test("an unused connector has no entry, and its cell reads as a missing value", () => {
    const byConnector = workflowsByConnector(workflows);
    const used = byConnector.get("archived-service") ?? [];
    expect(used).toEqual([]);
    expect(stringValue(used)).toBe("—");
  });

  test("no workflows at all leaves the index empty", () => {
    expect(workflowsByConnector([]).size).toBe(0);
  });
});
