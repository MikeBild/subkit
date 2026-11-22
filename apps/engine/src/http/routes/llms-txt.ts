import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  DocsBundleSchema,
  LLMS_PAGE_PATHS,
  type LlmsPage,
  renderLlmsIndex,
} from "@shared/llms-index.ts";
import type { Context } from "hono";
import {
  allowedDesktopLoginCallbacks,
  DESKTOP_LOGIN_CALLBACK,
  DESKTOP_LOGIN_START_PATH,
  DESKTOP_SESSION_PATH,
} from "../../auth/index.ts";
import { currentDeploymentMode } from "../../config/deployment-mode.ts";
import { getConfig } from "../../config/loader.ts";
import { DESKTOP_MIN_VERSION_DEFAULT } from "../../config/schema.ts";
import { ANONYMOUS_FEEDBACK_PATH } from "../../feedback/index.ts";
import { LOCAL_UNAVAILABLE_CAPABILITIES } from "../../identity/index.ts";
import docsJson from "../llms/docs.json" with { type: "text" };
import llmsFullTxt from "../llms/llms-full.txt" with { type: "text" };
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";
import { COMPOSE_YAML } from "./compose.ts";
import { SKILL_MD } from "./install-skill.ts";

const RESPONSE_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "public, max-age=3600",
} as const;

const DOCS_JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=3600",
} as const;

const docsJsonText = String(docsJson);

const docs = DocsBundleSchema.parse(JSON.parse(docsJsonText));

const pages: LlmsPage[] = LLMS_PAGE_PATHS.map((path) => {
  const page = docs.pages.find((p) => p.llms_path === path);
  if (!page) throw new Error(`docs bundle has no page for ${path}`);
  return { path, title: page.locales.en.title, summary: page.locales.en.summary };
});

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

export const DESKTOP_FEEDBACK_PATH = "/cockpit?feedback=1";

function desktopMinVersion(): string {
  try {
    return getConfig().server.desktop_min_version;
  } catch {
    return DESKTOP_MIN_VERSION_DEFAULT;
  }
}

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
    "A robots.txt-style index (https://llmstxt.org): setup, the subkit CLI, runtime settings and the connector catalog, each generated from the engine's code. Links drill down to /llms/{path}; /llms-full.txt carries all pages in one fetch.",
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

const docsJsonRoute = createRoute({
  method: "get",
  path: "/docs.json",
  tags: ["docs"],
  summary: "Every documentation chapter in English and German, in one fetch",
  description:
    "The documentation bundle this binary embeds: the reading sections with their English and German titles and descriptions, and each chapter with its audience, section, order within the section, headings, images, a sha256 and the Markdown body per locale. The engine version travels in the service descriptor and the x-subkit-docs-version header, never in the body.",
  responses: {
    200: {
      description: "Documentation bundle",
      content: { "application/json": { schema: DocsBundleSchema } },
    },
  },
});

function localDeploymentFields(): Record<string, { mode: string; unavailable_locally: string[] }> {
  if (currentDeploymentMode() !== "local_workspace") return {};
  return {
    deployment: {
      mode: "local_workspace",
      unavailable_locally: [...LOCAL_UNAVAILABLE_CAPABILITIES],
    },
  };
}

export function registerLlmsTxtRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(indexRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(wellKnownRoute, (c) => c.text(renderIndex(c), 200, RESPONSE_HEADERS));
  app.openapi(fullRoute, (c) => c.text(llmsFullTxt, 200, RESPONSE_HEADERS));
  app.openAPIRegistry.registerPath(docsJsonRoute);
  app.get(docsJsonRoute.path, (c) =>
    c.body(docsJsonText, 200, {
      ...DOCS_JSON_HEADERS,
      "x-subkit-docs-version": OPENAPI_INFO.version,
    }),
  );
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
        docs_json: {
          url: `${origin}/docs.json`,
          sha256: sha(docsJsonText),
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
      clients: {
        desktop: {
          min_version: desktopMinVersion(),
          login: {
            start: DESKTOP_LOGIN_START_PATH,
            session: DESKTOP_SESSION_PATH,
            callback: DESKTOP_LOGIN_CALLBACK,
            callbacks: allowedDesktopLoginCallbacks(),
            code_challenge_methods: ["S256"],
          },
          feedback_path: DESKTOP_FEEDBACK_PATH,
          anonymous_feedback_path: ANONYMOUS_FEEDBACK_PATH,
        },
      },
      ...localDeploymentFields(),
      capabilities: [
        "health",
        "ready",
        "metrics",
        "openapi",
        "llms-txt",
        "docs",
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
