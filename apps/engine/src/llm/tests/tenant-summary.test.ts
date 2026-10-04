import { describe, expect, test } from "bun:test";
import { renderTenantSummaryBlock, snapshotCoverage } from "../core/tenant-summary.ts";

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
    expect(text).toContain("DO NOT call list_workflows");
  });

  test("trims overly long lists and appends a ground-truth page hint", () => {
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

  test("a trimmed snapshot does not claim to be complete or forbid the list call", () => {
    const workflows = Array.from({ length: 40 }, (_, i) => ({
      id: `w-${i}`,
      slug: `aa-${i}`,
      name: `Workflow ${i}`,
      lifecycle: "active",
      is_tool: true,
      category: "aa",
    }));
    const text = renderTenantSummaryBlock({
      workflows,
      workflow_categories: [
        { category: "aa", count: 86 },
        { category: "notion", count: 8 },
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
      workflows_total: 94,
      connectors_total: 1,
    }) as string;
    expect(text).not.toContain("AUTHORITATIVE");
    expect(text).not.toContain("enumerate every workflow");
    expect(text).toContain("PARTIAL LIVE LIST");
    expect(text).toContain("Categories (exact counts over all 94): aa (86), notion (8)");
    expect(text).toContain("- aa-0 (active) — Workflow 0 [category=aa] [id=w-0]");
    expect(text).not.toContain("DO NOT call list_workflows");
    expect(text).toContain("The workflows lines above are incomplete.");
    expect(text).toContain("Never say a workflow or category does not exist");
    expect(text).toContain("answer from the lines above. DO NOT call list_connectors");
  });

  test("a complete snapshot keeps the authoritative wording and names the categories", () => {
    const text = renderTenantSummaryBlock({
      workflows: [
        {
          id: "w-1",
          slug: "notion-sync",
          name: "Notion Sync",
          lifecycle: "active",
          is_tool: true,
          category: "notion",
        },
      ],
      workflow_categories: [{ category: "notion", count: 1 }],
      connectors: [],
      workflows_total: 1,
      connectors_total: 0,
    }) as string;
    expect(text).toContain("THIS IS THE AUTHORITATIVE LIVE LIST");
    expect(text).toContain("Categories (exact counts over all 1): notion (1)");
    expect(text).toContain("DO NOT call list_workflows or list_connectors");
    expect(text).not.toContain("incomplete");
  });

  test("coverage is complete exactly up to the row cap", () => {
    expect(snapshotCoverage({ workflows_total: 40, connectors_total: 40 })).toEqual({
      workflows_complete: true,
      connectors_complete: true,
    });
    expect(snapshotCoverage({ workflows_total: 41, connectors_total: 0 })).toEqual({
      workflows_complete: false,
      connectors_complete: true,
    });
  });
});
