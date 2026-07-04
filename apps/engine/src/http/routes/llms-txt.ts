// llms-txt endpoints — the engine publishes its own docs in the llms-txt
// format (<https://llmstxt.org>) so any LLM client (MCP clients, the engine's
// own authoring loop) can ground itself on the sk surface at inference time:
//
//   GET /llms.txt              → robots.txt-style index of the docs set
//   GET /.well-known/llms.txt  → alias of /llms.txt (consumers probe it)
//   GET /llms/{path}           → one indexed page, drilled down from the index
//   GET /llms-full.txt         → the full docs set concatenated into one fetch
//
// The repo's committed docs/llms.txt uses repo-relative links (the repo is
// private, so raw.githubusercontent URLs are unusable as public targets). Over
// HTTP the engine self-hosts the drill-down: the index is RE-RENDERED from the
// embedded manifest with absolute `${origin}/llms/<path>` links, and each page
// is served from the embedded full text. The renderer is shared with the build
// script (@shared/llms-index) so the two surfaces can never drift in shape.
//
// Public and unauthenticated, like /openapi.json and /docs — the auth
// middleware is non-blocking and these handlers never call requireAuth.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type LlmsPage, OPTIONAL_PATHS, renderLlmsIndex } from "@shared/llms-index.ts";
import type { Context } from "hono";
import llmsFullTxt from "../../../../../docs/llms-full.txt" with { type: "text" };
// Repo-root docs, embedded at build time so the compiled binary serves them
// without a filesystem dependency. The manifest is the structured index; the
// full text carries every page's body behind `<!-- Source: docs/... -->`
// markers, which we split into a per-page section map once at module load.
import manifest from "../../../../../docs/llms-manifest.json" with { type: "json" };
import { getConfig } from "../../config/loader.ts";
import type { AppEnv } from "../openapi.ts";

const RESPONSE_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "public, max-age=3600",
} as const;

const pages: LlmsPage[] = manifest.pages;

// Split the embedded full text into Map<docsRelPath, sectionMarkdown> once, by
// the `<!-- Source: docs/<path> -->` markers the generator emits. The key has
// the leading `docs/` stripped (e.g. `concepts/connectors.md`) so it matches
// the `/llms/{path}` request param and the index's repo-relative links.
function buildSectionMap(full: string): Map<string, string> {
  const map = new Map<string, string>();
  const marker = /<!-- Source: docs\/(.+?) -->\n\n/g;
  const hits: Array<{ key: string; start: number; contentStart: number }> = [];
  let m: RegExpExecArray | null = marker.exec(full);
  while (m !== null) {
    hits.push({ key: m[1] ?? "", start: m.index, contentStart: marker.lastIndex });
    m = marker.exec(full);
  }
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (!hit) continue;
    const end = hits[i + 1]?.start ?? full.length;
    map.set(hit.key, full.slice(hit.contentStart, end).trimEnd());
  }
  return map;
}

const sections = buildSectionMap(llmsFullTxt);

// Origin the engine is reached at: the configured public base URL (proxy- and
// OAuth-issuer-correct), else the forwarded proto/host, else the request URL
// origin. Trailing slashes stripped so `${origin}/llms/...` is well-formed.
function resolveOrigin(c: Context<AppEnv>): string {
  const configured = getConfig().server.public_base_url;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = c.req.header("x-forwarded-proto");
  const host = c.req.header("x-forwarded-host");
  if (proto && host) return `${proto}://${host}`.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

function renderIndex(c: Context<AppEnv>): string {
  const origin = resolveOrigin(c);
  return renderLlmsIndex(pages, {
    linkFor: (p) => `${origin}/llms/${p.path.replace(/^docs\//, "")}`,
    fullUrl: `${origin}/llms-full.txt`,
    optional: (p) => OPTIONAL_PATHS.has(p.path),
  });
}

const indexRoute = createRoute({
  method: "get",
  path: "/llms.txt",
  tags: ["docs"],
  summary: "llms-txt index of the sk documentation set",
  description:
    "A robots.txt-style index (https://llmstxt.org) of the sk docs for LLMs: every public page with its title, link, and one-line summary, plus an Optional section. Links drill down to /llms/{path}; see /llms-full.txt for the full text in one fetch.",
  responses: {
    200: {
      description: "llms-txt index",
      content: { "text/markdown": { schema: z.string() } },
    },
  },
});

const wellKnownRoute = createRoute({
  method: "get",
  path: "/.well-known/llms.txt",
  tags: ["docs"],
  summary: "llms-txt index (well-known alias)",
  description: "Alias of /llms.txt at the well-known location consumers probe.",
  responses: {
    200: {
      description: "llms-txt index",
      content: { "text/markdown": { schema: z.string() } },
    },
  },
});

const fullRoute = createRoute({
  method: "get",
  path: "/llms-full.txt",
  tags: ["docs"],
  summary: "Full sk documentation set in one fetch (llms-txt full-content variant)",
  description:
    "The complete sk docs concatenated into a single llms-txt document (https://llmstxt.org), each page preceded by a source marker — enough to ground a model on the whole surface in one fetch.",
  responses: {
    200: {
      description: "Full llms-txt corpus",
      content: { "text/markdown": { schema: z.string() } },
    },
  },
});

export function registerLlmsTxtRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(indexRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(wellKnownRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(fullRoute, (c) => c.text(llmsFullTxt, 200, RESPONSE_HEADERS));

  // Per-page drill-down. The path spans slashes (e.g. `concepts/connectors.md`),
  // which @hono/zod-openapi's typed params can't express cleanly, so this one
  // route is a plain Hono handler with a `{.+}` regex param and is left off the
  // OpenAPI surface intentionally.
  app.get("/llms/:path{.+}", (c) => {
    const path = c.req.param("path");
    const section = sections.get(path);
    if (section === undefined) {
      return c.text(`Not found: /llms/${path}\nSee /llms.txt for the index.\n`, 404, {
        "content-type": "text/markdown; charset=utf-8",
      });
    }
    return c.text(`${section}\n`, 200, RESPONSE_HEADERS);
  });
}
