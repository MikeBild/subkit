import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { SCRAPER_PROJECT_URL } from "../../connectors/index.ts";
import type { AppEnv } from "../openapi.ts";
import { resolveOrigin } from "./llms-txt.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(origin: string): string {
  const host = new URL(origin).host;
  return `# sk-web-scraper

The engine at ${origin} runs SubKit, a workflow engine.
Its web scraper fetches a page only when a workflow of this installation asks for it.

- It sends the User-Agent \`sk-web-scraper/<version>\` with a link to this page.
- It follows robots.txt by default. To stop it, add:

  \`\`\`
  User-agent: sk-web-scraper
  Disallow: /
  \`\`\`

- It waits between requests to the same site.

This installation is run by the operator of ${host}, not by the SubKit project.
SubKit itself: ${SCRAPER_PROJECT_URL}
`;
}

function renderHtml(origin: string): string {
  const host = escapeHtml(new URL(origin).host);
  const safeOrigin = escapeHtml(origin);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sk-web-scraper</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; }
  pre { padding: .75rem 1rem; border: 1px solid rgba(128,128,128,.3); border-radius: .5rem; }
  footer { margin-top: 2rem; opacity: .7; font-size: .9rem; }
</style>
<h1>sk-web-scraper</h1>
<p>The engine at <code>${safeOrigin}</code> runs SubKit, a workflow engine.
Its web scraper fetches a page only when a workflow of this installation asks for it.</p>
<ul>
  <li>It sends the User-Agent <code>sk-web-scraper/&lt;version&gt;</code> with a link to this page.</li>
  <li>It follows robots.txt by default. To stop it, add:
<pre>User-agent: sk-web-scraper
Disallow: /</pre></li>
  <li>It waits between requests to the same site.</li>
</ul>
<p>This installation is run by the operator of <code>${host}</code>, not by the SubKit project.</p>
<footer>SubKit itself: <a href="${SCRAPER_PROJECT_URL}">${SCRAPER_PROJECT_URL}</a></footer>
</html>
`;
}

const route = createRoute({
  method: "get",
  path: "/bot",
  tags: ["docs"],
  summary: "What the web scraper is and how to stop it",
  description:
    "Public page the web scraper's User-Agent links to. Explains who runs the crawler and how to block it with robots.txt. Returns HTML to a browser and Markdown to everything else.",
  responses: {
    200: {
      description: "Scraper information (HTML for browsers, Markdown otherwise)",
      content: {
        "text/html": { schema: z.string() },
        "text/markdown": { schema: z.string() },
      },
    },
  },
});

export function registerBotRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, (c) => {
    const origin = resolveOrigin(c);
    return (c.req.header("accept") ?? "").includes("text/html")
      ? c.html(renderHtml(origin), 200, { "cache-control": "public, max-age=3600" })
      : c.text(renderMarkdown(origin), 200, {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=3600",
        });
  });
}
