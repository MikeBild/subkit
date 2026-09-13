import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { NAVIGATION } from "@/app/navigation";
import { ALL_ROUTE_PATHS, CATALOG_RESOURCES, PAGE_ROUTES } from "@/app/route-table";

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
    for (const path of ["/chat/new", "/chat/$conversationId"]) {
      expect(ALL_ROUTE_PATHS).toContain(path);
      expect(linked.has(path)).toBe(false);
    }
  });
});
