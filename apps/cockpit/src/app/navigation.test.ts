import { describe, expect, test } from "bun:test";
import {
  ATTENTION_READ_PERMISSIONS,
  NAVIGATION,
  navigationItem,
  navigationTarget,
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
      "nav.overview",
      "nav.chat",
      "nav.workflows",
    ]);
  });

  test("Übersicht shows for any source a reader may read, and for nothing else", () => {
    // A reviewer with only a skill or a workflow grant still has something to
    // do; gating Übersicht on `stats:read` hid it from exactly them.
    for (const permission of ATTENTION_READ_PERMISSIONS) expect(paths([permission])).toContain("/");
    expect(paths(["audit:read"])).not.toContain("/");
  });

  test("Übersicht and Chat stand at the top, without a heading", () => {
    const home = NAVIGATION[0];
    expect(home?.id).toBe("home");
    expect(home?.labelKey).toBeUndefined();
    expect(home?.items.map((item) => item.path)).toEqual(["/", "/chat"]);
  });

  test("the groups are the decided information architecture, in order", () => {
    expect(NAVIGATION.map((group) => group.items.map((item) => item.path))).toEqual([
      ["/", "/chat"],
      ["/workflows", "/connectors", "/knowledge"],
      ["/usage", "/audit", "/people", "/api-access", "/settings"],
    ]);
    expect(NAVIGATION.map((group) => group.labelKey)).toEqual([
      undefined,
      "nav.group.automation",
      "nav.group.admin",
    ]);
  });

  test("no entry for a page that was a second place for the same facts", () => {
    const all = NAVIGATION.flatMap((group) => group.items).map((item) => item.path);
    for (const gone of [
      "/decisions",
      "/operations",
      "/connections",
      "/access",
      "/runs",
      "/skills",
      "/files",
      "/notifications",
    ])
      expect(all).not.toContain(gone);
  });

  test("Wissen is one entry, active on its three tabs, linking the first one the reader may open", () => {
    for (const path of ["/knowledge", "/skills/abc", "/files"])
      expect(navigationItem(path)?.labelKey).toBe("nav.knowledge");
    for (const permission of ["knowledge:read", "skill:read", "file:read"])
      expect(paths([permission])).toContain("/knowledge");
    const knowledge = navigationItem("/knowledge");
    if (!knowledge) throw new Error("no Wissen entry");
    expect(navigationTarget(knowledge, ["knowledge:read", "skill:read"])).toBe("/knowledge");
    expect(navigationTarget(knowledge, ["skill:read", "file:read"])).toBe("/skills");
    expect(navigationTarget(knowledge, ["file:read"])).toBe("/files");
  });

  test("Einstellungen shows for the settings or the notifications alone", () => {
    expect(paths(["settings:read"])).toContain("/settings");
    expect(paths(["notification:read"])).toContain("/settings");
  });

  test("keeps the API contract next to each route", () => {
    const item = navigationItem("/workflows/7d222f5a");
    expect(item?.permission).toBe("workflow:read");
    expect(item?.api).toContain("GET /v1/workflows");
    expect(navigationItem("/")?.api).toContain("GET /v1/attention");
  });

  test("API-Zugang is one entry, shown for any of its sections", () => {
    for (const permission of ["api_key:read", "mcp_oauth_client:read", "connection:read"]) {
      expect(paths([permission])).toContain("/api-access");
    }
  });

  test("Personen & Rechte is one entry, shown for the directory or the rights alone", () => {
    expect(paths(["identity:read"])).toContain("/people");
    expect(paths(["rbac:read"])).toContain("/people");
    expect(paths(["api_key:read"])).not.toContain("/people");
    expect(navigationItem("/people")?.labelKey).toBe("nav.people");
  });

  test("uses the same read permissions as the engine routes", () => {
    expect(navigationItem("/usage")?.permission).toBe("stats:read");
    expect(navigationItem("/settings")?.permission).toBe("settings:read");
  });
});
