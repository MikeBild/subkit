import { describe, expect, test } from "bun:test";
import { navigationItem, visibleNavigation } from "./navigation";

describe("cockpit navigation contract", () => {
  test("does not render entries without their effective permission", () => {
    const groups = visibleNavigation(["conversation:read", "workflow:read"]);
    expect(groups.flatMap((group) => group.items).map((item) => item.labelKey)).toEqual([
      "nav.decisions",
      "nav.chat",
      "nav.workflows",
    ]);
  });

  test("decisions shows for any of its reading permissions and hides without them", () => {
    const skillOnly = visibleNavigation(["skill:read"]).flatMap((group) => group.items);
    expect(skillOnly.map((item) => item.labelKey)).toContain("nav.decisions");
    const unrelated = visibleNavigation(["audit:read"]).flatMap((group) => group.items);
    expect(unrelated.map((item) => item.labelKey)).not.toContain("nav.decisions");
  });

  test("decisions sits directly under the overview entry", () => {
    const home = visibleNavigation(["stats:read", "workflow:read"])[0];
    expect(home?.id).toBe("home");
    expect(home?.items.map((item) => item.labelKey)).toEqual(["nav.overview", "nav.decisions"]);
  });

  test("keeps the API contract next to each route", () => {
    const item = navigationItem("/workflows/7d222f5a");
    expect(item?.permission).toBe("workflow:read");
    expect(item?.api).toContain("GET /v1/workflows");
  });

  test("uses the same read permissions as the engine routes", () => {
    expect(navigationItem("/usage")?.permission).toBe("stats:read");
    expect(navigationItem("/operations")?.permission).toBe("stats:read");
    expect(navigationItem("/settings")?.permission).toBe("settings:read");
  });
});
