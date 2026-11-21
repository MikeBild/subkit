import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NAVIGATION } from "@/app/navigation";
import {
  ALL_ROUTE_PATHS,
  CATALOG_RESOURCES,
  INTAKE_ROUTES,
  INVITE_ROUTE,
  movedTarget,
  PAGE_ROUTES,
  RECOVERY_ROUTE,
  REDIRECT_ROUTES,
  RUN_ROUTE,
  STANDALONE_ROUTES,
  TASK_ROUTES,
  WELCOME_ROUTE,
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

  test("recovery, welcome and invitation stand alone, outside the authenticated router", () => {
    const source = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const router = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect([...STANDALONE_ROUTES]).toEqual([RECOVERY_ROUTE, WELCOME_ROUTE, INVITE_ROUTE]);
    expect(source).toContain(
      "STANDALONE_ROUTES.find((route) => window.location.pathname === absolute(route))",
    );
    for (const [route, page] of [
      ["RECOVERY_ROUTE", "IdentityRecoveryPage"],
      ["WELCOME_ROUTE", "WelcomePage"],
      ["INVITE_ROUTE", "InvitePage"],
    ]) {
      expect(source).toContain(`[${route}]: ${page},`);
      expect(router).not.toContain(page);
    }
    for (const route of STANDALONE_ROUTES) {
      expect(ALL_ROUTE_PATHS).toContain(route);
      expect(PAGE_ROUTES as readonly string[]).not.toContain(route);
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

  test("gives every intake item its own page next to the intake list", () => {
    expect(INTAKE_ROUTES).toEqual(["/intake", "/intake/$resourceId"]);
    expect(ALL_ROUTE_PATHS).toContain("/intake");
    expect(ALL_ROUTE_PATHS).toContain("/intake/$resourceId");
  });

  test("a row opens the record's own page, files and intake items included", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/path: "\/files\/\$resourceId",\s*component: FilePage/);
    expect(source).toMatch(/path: "\/intake\/\$resourceId",\s*component: InboxEntryPage/);
    for (const page of [
      "pages/catalog",
      "features/knowledge/sources",
      "features/knowledge/skills",
      "features/knowledge/files",
      "features/knowledge/inbox",
    ]) {
      const code = readFileSync(new URL(`../${page}.tsx`, import.meta.url), "utf8");
      expect(code, `${page} still previews rows in a sheet`).not.toMatch(
        /search: \{ item:|\?item=|RecordOpenLink/,
      );
      expect(code, `${page} rows do not link their page`).toContain("recordHref(");
    }
  });

  test("gives tasks a list page and a page per task, and a list row opens that page", () => {
    expect([...TASK_ROUTES]).toEqual(["/tasks", "/tasks/$resourceId"]);
    for (const path of TASK_ROUTES) expect(ALL_ROUTE_PATHS).toContain(path);
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/path: "\/tasks",\s*component: \(\) => <TasksPage/);
    expect(source).toMatch(/path: "\/tasks\/\$resourceId",\s*component: \(\) => <TaskPage/);
    const list = readFileSync(
      new URL("../features/tasks/ui/tasks-list.tsx", import.meta.url),
      "utf8",
    );
    expect(list).toContain("rowHref={(row) => taskHref(row.task.id)}");
    expect(list).not.toMatch(/RecordSheet|\?item=/);
  });

  test("gives one run its own page", () => {
    expect(ALL_ROUTE_PATHS).toContain(RUN_ROUTE);
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(RUN_ROUTE).toBe("/runs/$runId");
    expect(source).toMatch(/path: "\/runs\/\$runId",\s*component: RunPage/);
  });

  test("names the routes no menu links to, which is why they are here", () => {
    const linked = new Set(NAVIGATION.flatMap((group) => group.items).map((item) => item.path));
    for (const path of ["/chat/new", "/chat/$conversationId", "/docs", "/docs/$slug"]) {
      expect(ALL_ROUTE_PATHS).toContain(path);
      expect(linked.has(path)).toBe(false);
    }
  });

  test("sends the old Zugriff address to the roles under Settings › People", () => {
    expect(REDIRECT_ROUTES).toContain("/access");
    expect(PAGE_ROUTES as readonly string[]).not.toContain("/access");
    expect(ALL_ROUTE_PATHS).toContain("/access");
    const landed = movedTarget("");
    expect(landed).toBe("/settings?area=people&section=roles");
    expect(peopleSectionFromUrl(landed.slice(landed.indexOf("?")))).toBe("roles");
    expect(movedTarget("?section=permissions")).toBe("/settings?area=people&section=roles");
    expect(movedTarget("?q=admin")).toBe("/settings?area=people&section=roles&q=admin");
  });

  test("old run list, connection and notification addresses are gone, not redirected", () => {
    for (const gone of ["/runs", "/connections", "/notifications", "/decisions", "/operations"]) {
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

  test("knowledge, connectors and usage have one screen each, with no full-function switch", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/\} from "@\/features\/knowledge";/);
    expect(source).toContain('import { ConnectorsPage } from "@/features/connectors";');
    expect(source).toContain('import { UsagePage } from "@/features/usage";');
    expect(source).toContain('"/usage": UsagePage,');
    expect(source).not.toMatch(/knowledge-routes|classic-view|isClassicView|usage-route/);
    expect(source).not.toMatch(/@\/pages\/(files|intake|knowledge-sources|skills|usage)"/);
  });

  test("the installed app's file handler still opens the files screen", () => {
    const source = readFileSync(new URL("./router.tsx", import.meta.url), "utf8");
    expect(ALL_ROUTE_PATHS).toContain("/incoming/files");
    expect(source).toMatch(/path: "\/incoming\/files",\s*component: FilesPage/);
  });

  test("keeps every parameterised path out of the mapped page list", () => {
    const parameterised = PAGE_ROUTES.filter((path) => path.includes("$"));
    expect(parameterised, "a parameterised path in PAGE_ROUTES breaks every Link").toEqual([]);
  });
});
