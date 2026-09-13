import { describe, expect, test } from "bun:test";

import { NAVIGATION, navigationItem, visibleNavigation } from "./navigation";

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

  test("leaves the overview and decisions entries without a group heading", () => {
    const home = NAVIGATION.find((group) => group.id === "home");
    expect(home?.labelKey).toBeUndefined();
  });

  test("keeps the five entries the installation section owes the convention", () => {
    const installation = NAVIGATION.find((group) => group.id === "admin");
    expect(installation?.labelKey).toBe("nav.group.admin");
    // §6 pins the set, not the extras: the five come first and in this order,
    // product-specific entries follow.
    expect(installation?.items.slice(0, 5).map((item) => item.path)).toEqual([
      "/operations",
      "/settings",
      "/api-access",
      "/notifications",
      "/audit",
    ]);
  });

  test("uses the same read permissions as the engine routes", () => {
    expect(navigationItem("/usage")?.permission).toBe("stats:read");
    expect(navigationItem("/operations")?.permission).toBe("stats:read");
    expect(navigationItem("/settings")?.permission).toBe("settings:read");
  });
});
