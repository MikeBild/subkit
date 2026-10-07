import { describe, expect, test } from "bun:test";
import { summarize } from "./find-workflow.ts";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "example-site-daily-report",
  name: "Example-Site Status Report",
  current_version: 3,
  category: "reports",
};

describe("find_workflow summary", () => {
  test("carries the stored description and category", () => {
    const out = summarize({
      ...base,
      description: "Manueller Statusreport für https://www.example.com.",
      definition: { steps: [{ id: "site_ready", kind: "request", connector_id: "c1" }] },
    });
    expect(out.description).toBe("Manueller Statusreport für https://www.example.com.");
    expect(out.category).toBe("reports");
    expect(out.steps).toEqual([{ id: "site_ready", kind: "request", connector_id: "c1" }]);
  });

  test("null when the workflow has no description yet", () => {
    const out = summarize({ ...base, description: null, definition: { steps: [] } });
    expect(out.description).toBeNull();
  });
});
