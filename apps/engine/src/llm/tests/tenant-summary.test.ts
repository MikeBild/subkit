import { describe, expect, test } from "bun:test";
import { renderTenantSummaryBlock } from "../core/tenant-summary.ts";

describe("tenant-summary block", () => {
  test("returns null for an empty tenant", () => {
    expect(renderTenantSummaryBlock({ workflows: [], connectors: [] })).toBeNull();
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

  test("trims overly long lists and appends a page hint", () => {
    const workflows = Array.from({ length: 45 }, (_, i) => ({
      id: `w-${i}`,
      slug: `wf-${i}`,
      name: `Workflow ${i}`,
      lifecycle: "published",
      is_tool: true,
    }));
    const block = renderTenantSummaryBlock({ workflows, connectors: [] });
    const text = block as string;
    expect(text).toContain("… and 5 more — call list_workflows to page.");
  });
});
