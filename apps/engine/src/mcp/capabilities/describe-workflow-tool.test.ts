import { describe, expect, test } from "bun:test";
import { LISTED_DESCRIPTION_MAX } from "../../api/catalog-metadata.ts";
import { describeWorkflowTool } from "./tools-helpers.ts";

describe("describeWorkflowTool", () => {
  test("leads with the catalog block and states what the workflow is for", () => {
    expect(
      describeWorkflowTool({
        name: "Weekly sales digest",
        description: "Mails the weekly sales digest to finance.",
        category: "sales-reporting",
      }),
    ).toStartWith(
      '[sales-reporting] Run the saved workflow "Weekly sales digest" — Mails the weekly sales digest to finance.',
    );
  });

  test("names no block for the catch-all and falls back to the name alone", () => {
    const text = describeWorkflowTool({ name: "Probe", description: null, category: "other" });
    expect(text).toStartWith('Run the saved workflow "Probe". ');
  });

  test("keeps a long description on one bounded line", () => {
    const long = `${"Collects figures and publishes them.\n".repeat(30)}`;
    const text = describeWorkflowTool({ name: "Long", description: long, category: "reports" });
    const summary = text.split(" — ")[1]?.split(". Executes")[0] ?? "";
    expect(summary.includes("\n")).toBe(false);
    expect(summary.length).toBeLessThanOrEqual(LISTED_DESCRIPTION_MAX);
  });
});
