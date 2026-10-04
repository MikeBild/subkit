import { describe, expect, test } from "bun:test";
import { summarize } from "./find-workflow.ts";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "example-site-daily-report",
  name: "Example-Site Status Report",
  current_version: 3,
};

describe("find_workflow description precedence", () => {
  test("row description wins over a stale definition description", () => {
    const out = summarize({
      ...base,
      description: "Manueller Statusreport für https://www.example.com.",
      definition: {
        description: "STALE: GitHub-Repo-Status + Sitemap via browserless + E-Mail.",
        steps: [{ id: "site_ready", kind: "request", connector_id: "c1" }],
      },
    });
    expect(out.description).toBe("Manueller Statusreport für https://www.example.com.");
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
