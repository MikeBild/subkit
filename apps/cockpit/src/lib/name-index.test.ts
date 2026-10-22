import { describe, expect, test } from "bun:test";
import { buildNameIndex, resolveTargetName, skillTargetName } from "./name-index";

const index = buildNameIndex(
  [
    { id: "wf-1", name: "GA4 Tagesreport" },
    { id: "wf-2", name: "  ", slug: "radar-collect-weekly" },
    { id: "wf-3" },
  ],
  [
    { id: "co-1", name: "GitHub" },
    { id: "co-2", display_name: "Sales reporting API", slug: "sales-reporting-api" },
  ],
);

describe("resolveTargetName", () => {
  test("returns the name when it knows one", () => {
    expect(resolveTargetName(index, "workflow", "wf-1")).toBe("GA4 Tagesreport");
    expect(resolveTargetName(index, "connector", "co-1")).toBe("GitHub");
  });

  test("names a connector by its display name, not its slug", () => {
    expect(resolveTargetName(index, "connector", "co-2")).toBe("Sales reporting API");
  });

  test("falls back to the slug when the name is blank", () => {
    expect(resolveTargetName(index, "workflow", "wf-2")).toBe("radar-collect-weekly");
  });

  test("returns null — never the id — for anything it cannot name", () => {
    expect(resolveTargetName(index, "workflow", "wf-3")).toBeNull();
    expect(resolveTargetName(index, "workflow", "wf-unknown")).toBeNull();
    expect(resolveTargetName(index, "workflow", null)).toBeNull();
    expect(resolveTargetName(index, "workflow", undefined)).toBeNull();
  });

  test("does not confuse the two kinds of id", () => {
    expect(resolveTargetName(index, "connector", "wf-1")).toBeNull();
  });
});

describe("skillTargetName", () => {
  test("resolves against the scope the candidate was distilled for", () => {
    expect(skillTargetName(index, { scope: "workflow", workflow_id: "wf-1" })).toBe(
      "GA4 Tagesreport",
    );
    expect(skillTargetName(index, { scope: "connector", connector_id: "co-1" })).toBe("GitHub");
  });

  test("a global skill has no target rather than an unresolved one", () => {
    expect(skillTargetName(index, { scope: "global" })).toBeNull();
  });
});
