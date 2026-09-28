import { describe, expect, test } from "bun:test";
import {
  ATTENTION_READ_PERMISSIONS,
  NAVIGATION,
  navigationItem,
  visibleNavigation,
} from "./navigation";

const paths = (permissions: string[]) =>
  visibleNavigation(permissions)
    .flatMap((group) => group.items)
    .map((item) => item.path);

describe("cockpit navigation contract", () => {
  test("does not render entries without their effective permission", () => {
    const groups = visibleNavigation(["conversation:read", "workflow:read"]);
    expect(groups.flatMap((group) => group.items).map((item) => item.labelKey)).toEqual([
      "nav.today",
      "nav.chat",
      "nav.workflows",
    ]);
  });

  test("Heute shows for any source a reader may read, and for nothing else", () => {
    // A reviewer with only a skill or a workflow grant still has something to
    // do; gating Heute on `stats:read` hid it from exactly them.
    for (const permission of ATTENTION_READ_PERMISSIONS) expect(paths([permission])).toContain("/");
    expect(paths(["audit:read"])).not.toContain("/");
  });

  test("Heute stands alone at the top, without a heading", () => {
    const home = NAVIGATION[0];
    expect(home?.id).toBe("home");
    expect(home?.labelKey).toBeUndefined();
    expect(home?.items.map((item) => item.path)).toEqual(["/"]);
  });

  test("the groups are the v3 information architecture, in order", () => {
    expect(NAVIGATION.map((group) => group.items.map((item) => item.path))).toEqual([
      ["/"],
      ["/chat"],
      ["/workflows", "/runs", "/connectors"],
      ["/knowledge", "/skills", "/files"],
      ["/usage", "/settings", "/api-access", "/people", "/access", "/notifications", "/audit"],
    ]);
    expect(NAVIGATION.map((group) => group.labelKey)).toEqual([
      undefined,
      "nav.group.work",
      "nav.group.automation",
      "nav.group.knowledge",
      "nav.group.admin",
    ]);
  });

  test("no entry for a page that was a second place for the same facts", () => {
    const all = NAVIGATION.flatMap((group) => group.items).map((item) => item.path);
    for (const gone of ["/decisions", "/operations", "/connections"])
      expect(all).not.toContain(gone);
  });

  test("keeps the API contract next to each route", () => {
    const item = navigationItem("/workflows/7d222f5a");
    expect(item?.permission).toBe("workflow:read");
    expect(item?.api).toContain("GET /v1/workflows");
    expect(navigationItem("/")?.api).toContain("GET /v1/attention");
  });

  test("Zugangsdaten is the one rights entry, shown for any of its three sections", () => {
    for (const permission of ["api_key:read", "mcp_oauth_client:read", "connection:read"]) {
      expect(paths([permission])).toContain("/api-access");
    }
  });

  test("uses the same read permissions as the engine routes", () => {
    expect(navigationItem("/usage")?.permission).toBe("stats:read");
    expect(navigationItem("/settings")?.permission).toBe("settings:read");
  });
});
