import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import { COCKPIT_PREFIX, cockpitBundleAvailable } from "../cockpit.ts";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";
import { resolveOrigin } from "./llms-txt.ts";

interface Entry {
  path: string;
  what: string;
}

const ENTRIES: ReadonlyArray<Entry> = [
  { path: "/docker-compose.yml", what: "The topology that runs this exact release" },
  { path: "/install", what: "Installer for the matching subkit command-line client" },
  {
    path: "/install/skill",
    what: "Installer for an agent skill that asks the make-or-buy question mid-build",
  },
  {
    path: "/llms.txt",
    what: "Setup, CLI, settings and connectors, generated from the code — indexed",
  },
  { path: "/llms-full.txt", what: "Those same pages in one fetch, for a model" },
  {
    path: "/docs.json",
    what: "Every documentation chapter in English and German, as one JSON bundle",
  },
  { path: "/openapi.json", what: "The full API surface" },
  { path: "/docs", what: "That API surface as a browsable reference" },
  { path: "/cockpit", what: "The web interface; a browser that opens / lands here" },
  { path: "/engine", what: "This index as a page, at an address that does not redirect" },
  { path: "/health", what: "Liveness" },
  { path: "/ready", what: "Readiness, with its checks" },
  { path: "/bot", what: "What the web scraper is and how to stop it" },
  {
    path: "/.well-known/service-descriptor.json",
    what: "All of the above, listed with checksums",
  },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(origin: string): string {
  const rows = ENTRIES.map((e) => `- [${e.path}](${origin}${e.path}) — ${e.what}`).join("\n");
  return `# subkit

A governed workflow engine, version ${OPENAPI_INFO.version}, reachable at ${origin}.

Everything below is served by this engine out of its own binary.

${rows}

Start with /llms.txt if you are a model, /cockpit if you are a person, and
/docker-compose.yml if you want to run one of these yourself. A browser that
opens / goes straight to /cockpit; /engine shows this index to a browser.
`;
}

function renderHtml(origin: string): string {
  const rows = ENTRIES.map(
    (e) =>
      `<tr><td><a href="${escapeHtml(origin + e.path)}"><code>${escapeHtml(e.path)}</code></a></td><td>${escapeHtml(e.what)}</td></tr>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SubKit — ${escapeHtml(OPENAPI_INFO.version)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  p.sub { margin-top: 0; opacity: .75; }
  table { border-collapse: collapse; width: 100%; margin-top: 2rem; }
  td { padding: .5rem .75rem .5rem 0; border-bottom: 1px solid rgba(128,128,128,.25); vertical-align: top; }
  td:last-child { opacity: .8; }
  code { font-size: .95em; }
  footer { margin-top: 2.5rem; opacity: .7; font-size: .9rem; }
</style>
<h1>SubKit</h1>
<p class="sub">A governed workflow engine, version ${escapeHtml(OPENAPI_INFO.version)}.</p>
<p>Everything below is served by this engine out of its own binary.</p>
<table>
${rows}
</table>
<footer>Start with <a href="${escapeHtml(origin)}/cockpit">the web interface</a> if you are a person, or
<a href="${escapeHtml(origin)}/llms.txt">/llms.txt</a> if you are a model.</footer>
</html>
`;
}

export const ENGINE_INDEX_PATH = "/engine";
const VARY = "Accept, Sec-Fetch-Mode";
const INDEX_CACHE = "public, max-age=300";

const indexResponse = {
  description: "Entry point (HTML for browsers, Markdown otherwise)",
  content: {
    "text/html": { schema: z.string() },
    "text/markdown": { schema: z.string() },
  },
} as const;

const route = createRoute({
  method: "get",
  path: "/",
  tags: ["docs"],
  summary: "Open the Cockpit in a browser, or read what this engine hands out",
  description:
    "An entry point for someone holding only this URL. A browser navigation (Sec-Fetch-Mode: navigate, or an Accept header that names text/html before text/markdown) gets a non-cacheable temporary redirect to the Cockpit at /cockpit. Every other client gets the index of the artefacts this engine serves from its own binary — Compose file, installer, documentation, API surface, web interface and health — as Markdown, or as HTML when it asks for text/html. With server.root_redirect_to_cockpit set to false, or without a Cockpit bundle in this deployment, a browser gets that HTML index instead. The index stays reachable at /engine.",
  responses: {
    302: {
      description:
        "Temporary redirect to the Cockpit for a browser navigation. The target is the same-origin Cockpit path under the base path of server.public_base_url, never taken from the request.",
      headers: z.object({ location: z.string() }),
    },
    200: indexResponse,
  },
});

const engineIndexRoute = createRoute({
  method: "get",
  path: ENGINE_INDEX_PATH,
  tags: ["docs"],
  summary: "What this engine hands out",
  description:
    "The engine index at a stable address: the same entries as GET /, without the redirect to the Cockpit. Returns HTML to a client asking for text/html and Markdown to everything else.",
  responses: { 200: indexResponse },
});

function wantsHtml(c: Context<AppEnv>): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

export function isBrowserNavigation(
  accept: string | undefined,
  fetchMode: string | undefined,
): boolean {
  const types = (accept ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.split(";")[0]?.trim() ?? "");
  const html = types.indexOf("text/html");
  const markdown = types.indexOf("text/markdown");
  if (markdown >= 0 && (html < 0 || markdown < html)) return false;
  return html >= 0 || fetchMode?.toLowerCase() === "navigate";
}

export function cockpitLocation(publicBaseUrl: string): string {
  let basePath = "";
  if (publicBaseUrl) {
    try {
      basePath = new URL(publicBaseUrl).pathname.replace(/\/+$/, "");
    } catch {
      basePath = "";
    }
  }
  return `${basePath}${COCKPIT_PREFIX}`;
}

function cockpitRedirectTarget(): string | null {
  if (!isConfigLoaded()) return null;
  const server = getConfig().server;
  if (!server.root_redirect_to_cockpit) return null;
  return cockpitLocation(server.public_base_url ?? "");
}

function renderIndex(c: Context<AppEnv>) {
  const origin = resolveOrigin(c);
  return wantsHtml(c)
    ? c.html(renderHtml(origin), 200, { "cache-control": INDEX_CACHE, vary: VARY })
    : c.text(renderMarkdown(origin), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": INDEX_CACHE,
        vary: VARY,
      });
}

export interface RootRouteOptions {
  cockpitAvailable?: () => boolean;
}

export function registerRootRoute(app: OpenAPIHono<AppEnv>, options: RootRouteOptions = {}): void {
  const cockpitAvailable = options.cockpitAvailable ?? cockpitBundleAvailable;
  app.openapi(route, (c) => {
    if (isBrowserNavigation(c.req.header("accept"), c.req.header("sec-fetch-mode"))) {
      const target = cockpitRedirectTarget();
      if (target && cockpitAvailable()) {
        c.header("cache-control", "no-store");
        c.header("vary", VARY);
        return c.redirect(target, 302);
      }
    }
    return renderIndex(c);
  });
  app.openapi(engineIndexRoute, (c) => renderIndex(c));
}

export const ROOT_ENTRY_PATHS: ReadonlyArray<string> = ENTRIES.map((e) => e.path);
