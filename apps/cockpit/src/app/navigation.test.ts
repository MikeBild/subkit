import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  ATTENTION_READ_PERMISSIONS,
  NAVIGATION,
  navigationItem,
  visibleAccountNavigation,
  visibleNavigation,
  visiblePrimaryNavigation,
} from "./navigation";

const paths = (permissions: string[]) =>
  visibleNavigation(permissions)
    .flatMap((group) => group.items)
    .map((item) => item.path);

describe("cockpit navigation contract", () => {
  test("the tenant opens Overview, Chat leads the sidebar, and admin links live in the account menu", () => {
    const permissions = ["stats:read", "conversation:read", "workflow:read", "audit:read"];
    expect(
      visiblePrimaryNavigation(permissions).flatMap((group) =>
        group.items.map((item) => item.path),
      ),
    ).toEqual(["/chat", "/workflows"]);
    expect(visibleAccountNavigation(permissions).map((item) => item.path)).toEqual([
      "/usage",
      "/audit",
      "/settings",
    ]);
    expect(navigationItem("/")?.labelKey).toBe("nav.overview");
  });

  test("does not render entries without their effective permission", () => {
    const groups = visibleNavigation(["conversation:read", "workflow:read"]);
    expect(groups.flatMap((group) => group.items).map((item) => item.labelKey)).toEqual([
      "nav.overview",
      "nav.chat",
      "nav.workflows",
      "nav.settings",
    ]);
  });

  test("Übersicht shows for any source a reader may read, and for nothing else", () => {
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
      ["/workflows", "/connectors", "/tasks"],
      ["/intake", "/knowledge", "/skills", "/files"],
      ["/usage", "/audit", "/people", "/api-access", "/settings"],
    ]);
    expect(NAVIGATION.map((group) => group.labelKey)).toEqual([
      undefined,
      "nav.group.automation",
      "nav.group.knowledge",
      "nav.group.admin",
    ]);
    expect(translate("de", "nav.group.admin")).toBe("Verwaltung");
    expect(translate("en", "nav.group.admin")).toBe("Administration");
  });

  test("no entry for a page that was a second place for the same facts", () => {
    const all = NAVIGATION.flatMap((group) => group.items).map((item) => item.path);
    for (const gone of [
      "/decisions",
      "/operations",
      "/connections",
      "/access",
      "/runs",
      "/notifications",
    ])
      expect(all).not.toContain(gone);
  });

  test("Wissen is a heading over four entries, each behind its own read and active on its records", () => {
    expect(navigationItem("/intake")?.labelKey).toBe("nav.inbox");
    expect(navigationItem("/knowledge/abc")?.labelKey).toBe("nav.knowledgeSources");
    expect(navigationItem("/skills/abc")?.labelKey).toBe("nav.skills");
    expect(navigationItem("/files")?.labelKey).toBe("nav.files");
    expect(paths(["skill:read"])).toEqual(["/", "/skills", "/settings"]);
    expect(paths(["file:read"])).toEqual(["/files", "/settings"]);
    expect(paths(["intake:read"])).toEqual(["/", "/intake", "/settings"]);
    const icons = NAVIGATION.flatMap((group) => group.items).map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("Aufgaben follows the connectors, behind its own read, and stays active on a task", () => {
    expect(navigationItem("/tasks")?.labelKey).toBe("nav.tasks");
    expect(navigationItem("/tasks/abc")).toBe(navigationItem("/tasks"));
    expect(navigationItem("/tasks")?.permission).toBe("task:read");
    expect(navigationItem("/tasks")?.api).toContain("GET /v1/tasks");
    expect(paths(["task:read"])).toEqual(["/tasks", "/settings"]);
    expect(paths(["workflow:read", "connector:read"])).not.toContain("/tasks");
    expect(
      visiblePrimaryNavigation(["workflow:read", "connector:read", "task:read"]).flatMap((group) =>
        group.items.map((item) => item.path),
      ),
    ).toEqual(["/workflows", "/connectors", "/tasks"]);
    expect(translate("de", "nav.tasks")).toBe("Aufgaben");
    expect(translate("en", "nav.tasks")).toBe("Tasks");
  });

  test("Einstellungen shows for every signed-in person, because everybody has a profile", () => {
    expect(paths([])).toEqual(["/settings"]);
    expect(paths(["settings:read"])).toContain("/settings");
    expect(paths(["workflow:run"])).toContain("/settings");
    expect(visibleAccountNavigation([]).map((item) => item.path)).toEqual(["/settings"]);
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

  test("uses the decided API access label in German and English", () => {
    expect(navigationItem("/api-access")?.labelKey).toBe("nav.apiAccess");
    expect(translate("de", "nav.apiAccess")).toBe("API-Zugang");
    expect(translate("en", "nav.apiAccess")).toBe("API access");
  });

  test("Personen & Rechte is one entry, shown for the directory or the rights alone", () => {
    expect(paths(["identity:read"])).toContain("/people");
    expect(paths(["rbac:read"])).toContain("/people");
    expect(paths(["api_key:read"])).not.toContain("/people");
    expect(navigationItem("/people")?.labelKey).toBe("nav.people");
  });

  test("uses the same read permissions as the engine routes", () => {
    expect(navigationItem("/usage")?.permission).toBe("stats:read");
    expect(navigationItem("/settings")?.permission).toBeNull();
  });
});

describe("active navigation entry", () => {
  test("the current page and its nested routes resolve to their own entry", () => {
    for (const path of ["/files", "/files/abc", "/workflows", "/workflows/abc", "/chat"]) {
      const item = navigationItem(path);
      expect(item).toBeDefined();
      expect(item?.path).not.toBe("/");
    }
    expect(navigationItem("/files/abc")).toBe(navigationItem("/files"));
    expect(navigationItem("/workflows/abc")).toBe(navigationItem("/workflows"));
  });
});
