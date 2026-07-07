// Unit tests for find_workflow's description precedence (P3).
//
// Regression guard for the split that surfaced live: `update_workflow` writes
// the editable workflow-ROW description, but find_workflow used to read only
// the authoring-time `definition.description`, so a metadata-only edit left the
// MCP catalog showing stale text. The catalog must be row-first — same
// precedence as the HTTP surface (routes/workflows.ts) and MCP resources.

import { describe, expect, test } from "bun:test";
import { summarize } from "./find-workflow.ts";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "mikebild-dev-daily-report",
  name: "mikebild.dev Contentkit Status Report",
  current_version: 3,
};

describe("find_workflow description precedence", () => {
  test("row description wins over a stale definition description", () => {
    const out = summarize({
      ...base,
      description: "Manueller Contentkit-Statusreport für https://www.mikebild.dev.",
      definition: {
        description: "STALE: GitHub-Repo-Status + Sitemap via browserless + E-Mail.",
        steps: [{ id: "contentkit_ready", kind: "request", connector_id: "c1" }],
      },
    });
    expect(out.description).toBe("Manueller Contentkit-Statusreport für https://www.mikebild.dev.");
  });

  test("falls back to the definition description when the row description is absent", () => {
    const out = summarize({
      ...base,
      definition: { description: "Authoring-time description", steps: [] },
    });
    expect(out.description).toBe("Authoring-time description");
  });

  test("null when neither is present", () => {
    const out = summarize({ ...base, definition: { steps: [] } });
    expect(out.description).toBeNull();
  });
});
