import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NAVIGATION } from "@/app/navigation";
import {
  ALL_ROUTE_PATHS,
  CATALOG_RESOURCES,
  INTAKE_ROUTES,
  movedTarget,
  PAGE_ROUTES,
  RECOVERY_ROUTE,
  REDIRECT_ROUTES,
  STANDALONE_ROUTES,
} from "@/app/route-table";
import { peopleSectionFromUrl } from "./links";

function registeredPaths(): string[] {
  const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
  const found = (pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1] ?? "");
  return [
    ...found(/\bpath:\s*"([^"]+)"/g),
    ...found(/\bpath:\s*`([^`]+)`/g).map((path) => path.replace(/\$\{resource\}/g, "*")),
    ...found(/\bpath:\s*([A-Z_][A-Z0-9_]*)\b/g),
  ];
}

describe("cockpit route table", () => {
  test("registers no path the table does not know about", () => {
    const fromTable = new Set<string>([
      ...ALL_ROUTE_PATHS,
      "/*",
      "/*/$resourceId",
      "CHAT_PATH",
      "NEW_CHAT_PATH",
      "CONVERSATION_PATH",
    ]);
    const unknown = registeredPaths().filter((path) => !fromTable.has(path));
    expect(unknown, "a route exists that the sweep can never find").toEqual([]);
  });

  test("registers every page route the table names", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    for (const path of PAGE_ROUTES) {
      expect(source, `${path} has no component`).toContain(`"${path}":`);
    }
  });

  test("includes the standalone recovery entry without requiring an authenticated router", () => {
    const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(STANDALONE_ROUTES).toContain(RECOVERY_ROUTE);
    expect(ALL_ROUTE_PATHS).toContain(RECOVERY_ROUTE);
    expect(PAGE_ROUTES as readonly string[]).not.toContain(RECOVERY_ROUTE);
    expect(source).toContain("window.location.pathname === absolute(RECOVERY_ROUTE)");
    expect(source).toContain("<IdentityRecoveryPage />");
  });

  test("keeps every navigation target on a route that exists", () => {
    const paths = new Set(ALL_ROUTE_PATHS);
    for (const item of NAVIGATION.flatMap((group) => group.items)) {
      expect(paths.has(item.path), `${item.path} is linked but not routed`).toBe(true);
    }
  });

  test("gives every catalogue a list page and a detail page", () => {
    for (const resource of CATALOG_RESOURCES) {
      expect(ALL_ROUTE_PATHS).toContain(`/${resource}`);
      expect(ALL_ROUTE_PATHS).toContain(`/${resource}/$resourceId`);
    }
  });

  test("keeps intake as one review surface with query deep links", () => {
    expect(INTAKE_ROUTES).toEqual(["/intake"]);
    expect(ALL_ROUTE_PATHS).toContain("/intake");
    expect(ALL_ROUTE_PATHS).not.toContain("/intake/$resourceId");
  });

  test("names the routes no menu links to, which is why they are here", () => {
    const linked = new Set(NAVIGATION.flatMap((group) => group.items).map((item) => item.path));
    for (const path of ["/chat/new", "/chat/$conversationId", "/docs", "/docs/$slug"]) {
      expect(ALL_ROUTE_PATHS).toContain(path);
      expect(linked.has(path)).toBe(false);
    }
  });

  test("sends the old Zugriff address to the roles of Personen & Rechte", () => {
    expect(REDIRECT_ROUTES).toContain("/access");
    expect(PAGE_ROUTES as readonly string[]).not.toContain("/access");
    expect(ALL_ROUTE_PATHS).toContain("/access");
    const landed = movedTarget("");
    expect(landed).toBe("/people?section=roles");
    expect(peopleSectionFromUrl(landed.slice(landed.indexOf("?")))).toBe("roles");
    expect(movedTarget("?section=permissions")).toBe("/people?section=roles");
    expect(movedTarget("?q=admin")).toBe("/people?section=roles&q=admin");
  });

  test("old run, connection and notification addresses are gone, not redirected", () => {
    for (const gone of [
      "/runs",
      "/runs/$resourceId",
      "/connections",
      "/notifications",
      "/decisions",
      "/operations",
    ]) {
      expect(ALL_ROUTE_PATHS).not.toContain(gone);
    }
  });

  test("builds every redirect as a browser navigation on the raw query", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(source).toContain("REDIRECT_ROUTES.map(");
    expect(source).toContain("movedTarget(window.location.search)");
    expect(source).toContain("window.location.replace(");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/location\.searchStr|redirect\(\{/);
    expect(source).not.toContain("ConnectionsPage");
    expect(source).not.toContain("RunsPage");
    expect(source).not.toContain("NotificationsPage");
    expect(source).not.toContain("DecisionsPage");
    expect(source).not.toContain("OperationsPage");
    expect(source).not.toMatch(/\bAccessPage\b/);
  });

  test("keeps every parameterised path out of the mapped page list", () => {
    const parameterised = PAGE_ROUTES.filter((path) => path.includes("$"));
    expect(parameterised, "a parameterised path in PAGE_ROUTES breaks every Link").toEqual([]);
  });
});
