import { describe, expect, test } from "bun:test";
import { renderTenantSummaryBlock } from "../core/tenant-summary.ts";

describe("tenant-summary block", () => {
  test("returns null for an empty tenant", () => {
    expect(
      renderTenantSummaryBlock({
        workflows: [],
        connectors: [],
        workflows_total: 0,
        connectors_total: 0,
      }),
    ).toBeNull();
  });

  test("renders workflows + connectors with ids quoted inline", () => {
    const block = renderTenantSummaryBlock({
      workflows: [
        {
          id: "w-1",
          slug: "nightly-sync",
          name: "Nightly Sync",
          lifecycle: "published",
          is_tool: true,
        },
        {
          id: "w-2",
          slug: "draft-x",
          name: "Draft X",
          lifecycle: "draft",
          is_tool: false,
        },
      ],
      connectors: [
        {
          id: "c-1",
          slug: "hubspot",
          display_name: "HubSpot",
          driver: "http",
          environment: "prod",
        },
      ],
      workflows_total: 2,
      connectors_total: 1,
    });
    expect(block).toBeTruthy();
    const text = block as string;
    expect(text).toContain("TENANT SNAPSHOT");
    expect(text).toContain("nightly-sync (published) — Nightly Sync [id=w-1]");
    expect(text).toContain("draft-x (draft) [authoring-only] — Draft X [id=w-2]");
    expect(text).toContain("hubspot (http/prod) — HubSpot [id=c-1]");
    // Tells the model not to re-list.
    expect(text).toContain("DO NOT call list_workflows");
  });

  test("trims overly long lists and appends a ground-truth page hint", () => {
    // The block shows at most 40 rows; the loader reports the EXACT
    // tenant-wide total alongside, so the "… and N more" line and the
    // headline count are ground truth even when far more rows exist.
    const workflows = Array.from({ length: 40 }, (_, i) => ({
      id: `w-${i}`,
      slug: `wf-${i}`,
      name: `Workflow ${i}`,
      lifecycle: "published",
      is_tool: true,
    }));
    const block = renderTenantSummaryBlock({
      workflows,
      connectors: [],
      workflows_total: 45,
      connectors_total: 0,
    });
    const text = block as string;
    expect(text).toContain("Workflows (45 total):");
    expect(text).toContain("… and 5 more — call list_workflows for the complete set.");
  });
});
