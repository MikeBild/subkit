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

const ENGINE_SRC = join(import.meta.dir, "..", "..", "..", "engine", "src");
const ENGINE_NON_PAGES = new Set(["/cockpit/favicon.svg", "/cockpit/{path}"]);

function engineCockpitAddresses(): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") walk(full);
      } else if (/\.ts$/.test(entry.name) && !entry.name.includes(".test.")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/['"`}](\/cockpit(?![\w-])[^"'`\s]*)/g)) {
          const value = m[1]!;
          if (value.startsWith("/cockpit${")) continue;
          out.push({ file: full, value });
        }
        for (const m of text.matchAll(/\bcockpitHref\(\s*"([^"]*)"/g))
          out.push({ file: full, value: `/cockpit${m[1]}` });
      }
    }
  };
  walk(ENGINE_SRC);
  return out;
}

function engineRoute(value: string): string {
  const path = value.split(/[?#]/)[0] ?? "";
  const filled = path.replace(/\$\{[^}]*\}?/g, "x").replace(/^\/cockpit/, "") || "/";
  return filled.length > 1 ? filled.replace(/\/$/, "") : filled;
}

test("every cockpit address the engine hands out resolves to one of the cockpit's pages", () => {
  const found = engineCockpitAddresses();
  const producers = new Set(found.map((entry) => entry.file.split("/").pop()));
  for (const known of [
    "attention-readers.ts",
    "operational-overview.ts",
    "operating-figures.ts",
    "oauth-origin.ts",
  ])
    expect(producers.has(known)).toBe(true);
  const dead = found
    .filter((entry) => !ENGINE_NON_PAGES.has(entry.value))
    .filter((entry) => !(entry.value === "/cockpit/" || resolves(engineRoute(entry.value))))
    .map((entry) => `${entry.file}: ${entry.value}`);
  expect(dead).toEqual([]);
});

test("the engine names no retired cockpit address", () => {
  const retired =
    /^\/cockpit\/(runs|connections|notifications|inbox|decisions|operations|system|today)\b/;
  const named = engineCockpitAddresses()
    .filter((entry) => retired.test(entry.value))
    .map((entry) => `${entry.file}: ${entry.value}`);
  expect(named).toEqual([]);
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
