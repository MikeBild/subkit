import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type LlmsPage, renderLlmsIndex } from "@shared/llms-index.ts";
import type { Context } from "hono";
import { getConfig } from "../../config/loader.ts";
import llmsFullTxt from "../llms/llms-full.txt" with { type: "text" };
import manifest from "../llms/manifest.json" with { type: "json" };
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { COMPOSE_YAML } from "./compose.ts";
import { SKILL_MD } from "./install-skill.ts";

const RESPONSE_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "public, max-age=3600",
} as const;

const pages: LlmsPage[] = manifest.pages;

function buildSectionMap(full: string): Map<string, string> {
  const map = new Map<string, string>();
  const marker = /<!-- Source: (.+?) -->\n\n/g;
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

export function resolveOrigin(c: Context<AppEnv>): string {
  let configured = "";
  try {
    configured = getConfig().server.public_base_url ?? "";
  } catch {
    configured = "";
  }
  if (configured) return configured.replace(/\/+$/, "");
  const proto = c.req.header("x-forwarded-proto");
  const host = c.req.header("x-forwarded-host");
  if (proto && host) return `${proto}://${host}`.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

function renderIndex(c: Context<AppEnv>): string {
  const origin = resolveOrigin(c);
  return renderLlmsIndex(pages, {
    linkFor: (p) => `${origin}/llms/${p.path}`,
    fullUrl: `${origin}/llms-full.txt`,
  });
}

const indexRoute = createRoute({
  method: "get",
  path: "/llms.txt",
  tags: ["docs"],
  summary: "llms-txt index of what this engine describes about itself",
  description:
    "A robots.txt-style index (https://llmstxt.org): setup, the sk CLI, runtime settings and the connector catalog, each generated from the engine's code. Links drill down to /llms/{path}; /llms-full.txt carries all pages in one fetch.",
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
  summary: "Everything this engine carries, in one fetch",
  description:
    "Every page this binary embeds, concatenated into a single llms-txt document (https://llmstxt.org), each preceded by a source marker.",
  responses: {
    200: {
      description: "Full llms-txt corpus",
      content: { "text/markdown": { schema: z.string() } },
    },
  },
});

const descriptorRoute = createRoute({
  method: "get",
  path: "/.well-known/service-descriptor.json",
  tags: ["docs"],
  summary: "Version and a sha256 per self-description artifact",
  description:
    "One small GET that tells a watcher whether anything changed. Asking the same question by downloading the documents costs ~600 KB per round here — llms-full.txt alone — almost always to discover nothing changed, which is what makes a frequent drift check unaffordable and an infrequent one useless.",
  responses: {
    200: {
      description: "Service descriptor",
      content: { "application/json": { schema: z.object({}).passthrough() } },
    },
  },
});

export function registerLlmsTxtRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(indexRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(wellKnownRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(fullRoute, (c) => c.text(llmsFullTxt, 200, RESPONSE_HEADERS));
  app.openapi(descriptorRoute, (c) => {
    const origin = resolveOrigin(c);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    return c.json({
      service: "subkit",
      version: OPENAPI_INFO.version,
      artifacts: {
        openapi: { url: `${origin}/openapi.json`, sha256: null, updated_at: null },
        llms_txt: { url: `${origin}/llms.txt`, sha256: sha(renderIndex(c)), updated_at: null },
        llms_full_txt: {
          url: `${origin}/llms-full.txt`,
          sha256: sha(llmsFullTxt),
          updated_at: null,
        },
        compose: {
          url: `${origin}/docker-compose.yml`,
          sha256: sha(COMPOSE_YAML),
          updated_at: null,
        },
        skill: {
          url: `${origin}/install/skill/SKILL.md`,
          sha256: sha(SKILL_MD),
          updated_at: null,
        },
      },
      capabilities: [
        "health",
        "ready",
        "metrics",
        "openapi",
        "llms-txt",
        "mcp",
        "descriptor",
        "compose",
        "skill",
      ],
    });
  });

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
