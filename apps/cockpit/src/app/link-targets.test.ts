import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as links from "./links";
import { ALL_ROUTE_PATHS, CATALOG_RESOURCES } from "./route-table";

const SRC = join(import.meta.dir, "..");
const ROUTES = new Set<string>(ALL_ROUTE_PATHS);

function builtPaths(): { file: string; value: string; router: boolean }[] {
  const out: { file: string; value: string; router: boolean }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/\bto=\{?"(\/[^"${}]*)"/g))
          out.push({ file: full, value: m[1]!, router: true });
        for (const m of text.matchAll(/"(\/cockpit\/[^"${}]*)"/g))
          out.push({ file: full, value: m[1]!, router: false });
      }
    }
  };
  walk(SRC);
  return out;
}

function routeOf(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.replace(/\/\$[A-Za-z]+$/, "/$resourceId") || "/";
}

test("a router link never repeats the base path the router already carries", () => {
  const doubled = builtPaths()
    .filter((entry) => entry.router && entry.value.startsWith("/cockpit"))
    .map((entry) => `${entry.file}: to="${entry.value}"`);
  expect(doubled).toEqual([]);
});

const ROUTE_PATTERNS = ALL_ROUTE_PATHS.map(
  (path) => new RegExp(`^${path.replace(/\$[A-Za-z]+/g, "[^/]+")}$`),
);
const resolves = (href: string) =>
  ROUTE_PATTERNS.some((pattern) => pattern.test(href.split("?")[0] ?? ""));

test("every address a link builder produces resolves to one of the cockpit's pages", () => {
  const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
  const built = {
    runs: links.runsHref({ workflowId: id, status: "failed", source: "scheduler", q: "x" }),
    run: links.runHref(id),
    workflow: links.workflowHref(id),
    connector: links.connectorHref(id),
    ...Object.fromEntries(
      CATALOG_RESOURCES.map((resource) => [`record:${resource}`, links.recordHref(resource, id)]),
    ),
    workflows: links.workflowsHref({ connector: "crm" }),
    conversation: links.conversationHref(id),
    settings: links.settingsHref("server.public_base_url"),
    audit: links.auditHref({
      resourceType: "workflow",
      resourceId: id,
      traceId: "t",
      scope: "all",
    }),
    chatNew: links.chatNewHref({ prompt: "p", workflowId: id }),
    apiAccess: links.apiAccessHref("keys"),
  };
  const dead = Object.entries(built)
    .filter(([, href]) => !resolves(href))
    .map(([name, href]) => `${name}: ${href}`);
  expect(dead).toEqual([]);
  for (const href of Object.values(built))
    expect(links.absolute(href)).toBe(
      href.startsWith("/?") ? `/cockpit${href.slice(1)}` : `/cockpit${href}`,
    );
});

test("Übersicht and its review sheet resolve to the start page, spelled as the engine spells them", () => {
  const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
  const review = links.attentionHref({ review: `workflow:${id}` });
  expect(resolves(review)).toBe(true);
  expect(resolves(links.attentionHref())).toBe(true);
  expect(links.absolute(review)).toBe(`/cockpit?review=workflow:${id}`);
  expect(links.routerPath(`/cockpit?review=workflow:${id}`)).toBe(review);
  expect(links.absolute(links.attentionHref())).toBe("/cockpit");
});

test("every address the cockpit builds resolves to one of its pages", () => {
  const dead = builtPaths()
    .map((entry) => ({
      ...entry,
      route: routeOf(entry.router ? entry.value : entry.value.replace(/^\/cockpit/, "") || "/"),
    }))
    .filter((entry) => !ROUTES.has(entry.route))
    .map((entry) => `${entry.file}: ${entry.value} -> ${entry.route}`);
  expect(dead).toEqual([]);
});
