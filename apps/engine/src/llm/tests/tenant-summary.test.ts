import { describe, expect, test } from "bun:test";
import { renderTenantSummaryBlock, snapshotCoverage } from "../core/tenant-summary.ts";

const NO_TOOLS: ReadonlySet<string> = new Set();

describe("tenant-summary block", () => {
  test("returns null for an empty tenant", () => {
    expect(
      renderTenantSummaryBlock(
        {
          workflows: [],
          connectors: [],
          workflows_total: 0,
          connectors_total: 0,
        },
        NO_TOOLS,
      ),
    ).toBeNull();
  });

  test("renders workflows + connectors with ids quoted inline", () => {
    const block = renderTenantSummaryBlock(
      {
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
      },
      new Set(["nightly-sync"]),
    );
    expect(block).toBeTruthy();
    const text = block as string;
    expect(text).toContain("TENANT SNAPSHOT");
    expect(text).toContain(
      "nightly-sync (published) [tool: wf_nightly-sync] — Nightly Sync [id=w-1]",
    );
    expect(text).toContain("draft-x (draft) [authoring-only] — Draft X [id=w-2]");
    expect(text).toContain("hubspot (http/prod) — HubSpot [id=c-1]");
    expect(text).toContain("DO NOT call list_workflows");
  });

  test("marks only the workflows that are exposed as wf_ tools this turn", () => {
    const text = renderTenantSummaryBlock(
      {
        workflows: [
          { id: "w-1", slug: "in-palette", name: "In Palette", lifecycle: "active", is_tool: true },
          {
            id: "w-2",
            slug: "evicted-from-palette",
            name: "Evicted",
            lifecycle: "active",
            is_tool: true,
          },
          { id: "w-3", slug: "draft-only", name: "Draft", lifecycle: "draft", is_tool: false },
        ],
        connectors: [],
        workflows_total: 3,
        connectors_total: 0,
      },
      new Set(["in-palette"]),
    ) as string;
    expect(text).toContain("- in-palette (active) [tool: wf_in-palette] — In Palette [id=w-1]");
    expect(text).toContain("- evicted-from-palette (active) — Evicted [id=w-2]");
    expect(text).not.toContain("wf_evicted-from-palette");
    expect(text).toContain("- draft-only (draft) [authoring-only] — Draft [id=w-3]");
    expect(text).not.toContain("wf_draft-only");
    expect(text).toContain(
      "Workflows marked [tool: wf_<slug>] are callable directly as that tool; every other workflow runs via run_workflow(workflow=<slug>).",
    );
    expect(text).not.toContain("Each workflow above is also exposed");
  });

  test("trims overly long lists and appends a ground-truth page hint", () => {
    const workflows = Array.from({ length: 40 }, (_, i) => ({
      id: `w-${i}`,
      slug: `wf-${i}`,
      name: `Workflow ${i}`,
      lifecycle: "published",
      is_tool: true,
    }));
    const block = renderTenantSummaryBlock(
      {
        workflows,
        connectors: [],
        workflows_total: 45,
        connectors_total: 0,
      },
      NO_TOOLS,
    );
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
    const text = renderTenantSummaryBlock(
      {
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
      },
      NO_TOOLS,
    ) as string;
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
    const text = renderTenantSummaryBlock(
      {
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
      },
      new Set(["notion-sync"]),
    ) as string;
    expect(text).toContain("THIS IS THE AUTHORITATIVE LIVE LIST");
    expect(text).toContain("Categories (exact counts over all 1): notion (1)");
    expect(text).toContain("DO NOT call list_workflows or list_connectors");
    expect(text).toContain("[tool: wf_notion-sync]");
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
