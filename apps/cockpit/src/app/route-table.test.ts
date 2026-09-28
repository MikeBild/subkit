import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NAVIGATION } from "@/app/navigation";
import {
  ALL_ROUTE_PATHS,
  CATALOG_RESOURCES,
  legacyTarget,
  PAGE_ROUTES,
  REDIRECT_ROUTES,
} from "@/app/route-table";
import { apiAccessSectionFromUrl, peopleSectionFromUrl, reviewFromUrl } from "./links";

/**
 * The router cannot be imported here — it reaches `window` while it loads — so
 * its registered paths are read out of its source instead.
 *
 * That is the point of the test rather than a workaround for it: what has to be
 * proven is that no path is registered ANYWHERE but the table. A route created
 * with a literal path, in a file nobody thinks about again, is exactly the route
 * the conformity sweep can never find.
 */
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
      // The two catalogue templates, once each: the router writes them with a
      // loop variable, and the table spells them out per resource.
      "/*",
      "/*/$resourceId",
      // Paths the router reads off the table by name keep the name in source.
      "CHAT_PATH",
      "NEW_CHAT_PATH",
      "CONVERSATION_PATH",
      "RUNS_PATH",
      "RUN_PATH",
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

  test("names the routes no menu links to, which is why they are here", () => {
    // Each of these is reachable by typing, bookmarking or being sent a link,
    // and none of them appears in NAVIGATION.
    const linked = new Set(NAVIGATION.flatMap((group) => group.items).map((item) => item.path));
    for (const path of ["/chat/new", "/chat/$conversationId", "/runs/$resourceId"]) {
      expect(ALL_ROUTE_PATHS).toContain(path);
      expect(linked.has(path)).toBe(false);
    }
  });

  test("gives one run an address without giving it a second surface", () => {
    // The sheet opened from local state, so nothing outside the page could
    // point at a single run — not an audit row, not a decision, not a metric.
    // The fix is an address, NOT a second detail view: both paths resolve to
    // the same component, and to the same FUNCTION, because React preserves a
    // page's state across a route change only while the element type is
    // identical. Two components would cost the reader their filters and their
    // page on every click, and leave two run views to keep in step.
    expect(ALL_ROUTE_PATHS).toContain("/runs");
    expect(ALL_ROUTE_PATHS).toContain("/runs/$resourceId");
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect([...source.matchAll(/component:\s*RunsPage\b/g)]).toHaveLength(2);
    expect(source).toContain("RUN_ROUTES");
    // And not through CATALOG_RESOURCES: that list wires the generic
    // catalogue pair, whose resource maps have no entry for runs.
    expect(CATALOG_RESOURCES as readonly string[]).not.toContain("runs");
  });

  test("sends the old Kontoverbindungen address to its section on Zugangsdaten, query and all", () => {
    // `/connections` became a section of `/api-access`. A bookmark and an
    // OAuth callback issued before the move both still land on the old path,
    // the callback with its result in the query — dropping it would swallow
    // the one sentence that says whether the connection worked.
    expect(REDIRECT_ROUTES).toContain("/connections");
    expect(PAGE_ROUTES as readonly string[]).not.toContain("/connections");
    expect(ALL_ROUTE_PATHS).toContain("/connections");
    const landed = legacyTarget("/connections", "?connected=wiki&renewed=1");
    expect(landed).toBe("/api-access?section=grants&connected=wiki&renewed=1");
    expect(apiAccessSectionFromUrl(landed.slice(landed.indexOf("?")))).toBe("grants");
    expect(legacyTarget("/connections", "?failed=denied&name=wiki+crm&section=keys")).toBe(
      "/api-access?section=grants&failed=denied&name=wiki+crm",
    );
    expect(legacyTarget("/connections", "")).toBe("/api-access?section=grants");
    // Values that look like JSON numbers stay exactly as sent.
    expect(legacyTarget("/connections", "?connected=1e5&name=12345678901234567890")).toBe(
      "/api-access?section=grants&connected=1e5&name=12345678901234567890",
    );
  });

  test("sends the old Zugriff address to the roles of Personen & Rechte", () => {
    // `/access` became three sections of `/people`. A bookmark lands on the
    // roles — what the old page opened with — and its own `section` wins over
    // one the old address carried (its tabs included a permissions list that
    // is no section any more).
    expect(REDIRECT_ROUTES).toContain("/access");
    expect(PAGE_ROUTES as readonly string[]).not.toContain("/access");
    expect(ALL_ROUTE_PATHS).toContain("/access");
    const landed = legacyTarget("/access", "");
    expect(landed).toBe("/people?section=roles");
    expect(peopleSectionFromUrl(landed.slice(landed.indexOf("?")))).toBe("roles");
    expect(legacyTarget("/access", "?section=permissions")).toBe("/people?section=roles");
    expect(legacyTarget("/access", "?q=admin")).toBe("/people?section=roles&q=admin");
  });

  test("sends the decisions queue and the system page to Übersicht", () => {
    const W = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    for (const path of ["/decisions", "/operations"] as const) {
      expect(REDIRECT_ROUTES).toContain(path);
      expect(PAGE_ROUTES as readonly string[]).not.toContain(path);
      // Still routed: the sweep visits an old address and sees where it lands.
      expect(ALL_ROUTE_PATHS).toContain(path);
    }
    expect(legacyTarget("/decisions", "")).toBe("/");
    // A bucket narrowed a page that no longer exists; it does not travel.
    for (const bucket of ["blocked", "failing", "overdue", "other"])
      expect(legacyTarget("/decisions", `?bucket=${bucket}`)).toBe("/");
    // One workflow's decisions open that workflow's review sheet.
    const review = legacyTarget("/decisions", `?workflow_id=${W}`);
    expect(review).toBe(`/?review=workflow:${W}`);
    expect(reviewFromUrl(review.slice(1))).toBe(`workflow:${W}`);
    expect(legacyTarget("/decisions", `?bucket=failing&workflow_id=${W}`)).toBe(
      `/?review=workflow:${W}`,
    );
    // Not a workflow id: Übersicht, never a sheet for an address nobody wrote.
    expect(legacyTarget("/decisions", "?workflow_id=1e5")).toBe("/");
    expect(legacyTarget("/operations", "")).toBe("/");
    expect(legacyTarget("/operations", "?tab=health")).toBe("/");
  });

  test("builds every redirect as a browser navigation on the raw query", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(source).toContain("REDIRECT_ROUTES.map(");
    // The raw query, and a browser navigation: the router's own search
    // serialiser JSON-parses values (`1e5` → `100000`) on both of its paths.
    expect(source).toContain("legacyTarget(path, window.location.search)");
    expect(source).toContain("window.location.replace(");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/location\.searchStr|redirect\(\{/);
    expect(source).not.toContain("ConnectionsPage");
    expect(source).not.toContain("DecisionsPage");
    expect(source).not.toContain("OperationsPage");
    expect(source).not.toMatch(/\bAccessPage\b/);
  });

  test("keeps every parameterised path out of the mapped page list", () => {
    // PAGE_ROUTES is mapped over in the router, and a mapped tuple collapses
    // to the union of its members. One parameterised member therefore makes
    // `params` a REQUIRED prop on every `<Link>` aimed at any member — the
    // typecheck broke on `to="/runs"` and `to="/audit"` when `/runs/$resourceId`
    // was first put here. Paths that take a record belong in their own group,
    // read off by position so they keep their literal type.
    const parameterised = PAGE_ROUTES.filter((path) => path.includes("$"));
    expect(parameterised, "a parameterised path in PAGE_ROUTES breaks every Link").toEqual([]);
  });
});
