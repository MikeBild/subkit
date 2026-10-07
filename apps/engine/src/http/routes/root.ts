import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";
import { resolveOrigin } from "./llms-txt.ts";

interface Entry {
  path: string;
  what: string;
}

const ENTRIES: ReadonlyArray<Entry> = [
  { path: "/docker-compose.yml", what: "The topology that runs this exact release" },
  { path: "/install", what: "Installer for the matching sk command-line client" },
  {
    path: "/install/skill",
    what: "Installer for an agent skill that asks the make-or-buy question mid-build",
  },
  {
    path: "/llms.txt",
    what: "Setup, CLI, settings and connectors, generated from the code — indexed",
  },
  { path: "/llms-full.txt", what: "Those same pages in one fetch, for a model" },
  { path: "/openapi.json", what: "The full API surface" },
  { path: "/docs", what: "That API surface as a browsable reference" },
  { path: "/cockpit", what: "The web interface" },
  { path: "/health", what: "Liveness" },
  { path: "/ready", what: "Readiness, with its checks" },
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
  return `# sk

A governed workflow engine, version ${OPENAPI_INFO.version}, reachable at ${origin}.

Everything below is served by this engine out of its own binary.

${rows}

Start with /llms.txt if you are a model, /cockpit if you are a person, and
/docker-compose.yml if you want to run one of these yourself.
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

const route = createRoute({
  method: "get",
  path: "/",
  tags: ["docs"],
  summary: "What this engine hands out",
  description:
    "An entry point for someone holding only this URL: the artefacts this engine serves from its own binary — Compose file, installer, documentation, API surface, web interface and health. Returns HTML to a browser and Markdown to everything else.",
  responses: {
    200: {
      description: "Entry point (HTML for browsers, Markdown otherwise)",
      content: {
        "text/html": { schema: z.string() },
        "text/markdown": { schema: z.string() },
      },
    },
  },
});

function wantsHtml(c: Context<AppEnv>): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

export function registerRootRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, (c) => {
    const origin = resolveOrigin(c);
    return wantsHtml(c)
      ? c.html(renderHtml(origin), 200, { "cache-control": "public, max-age=300" })
      : c.text(renderMarkdown(origin), 200, {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=300",
        });
  });
}

export const ROOT_ENTRY_PATHS: ReadonlyArray<string> = ENTRIES.map((e) => e.path);
