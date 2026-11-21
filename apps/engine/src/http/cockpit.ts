import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { logger } from "../logging/logger.ts";
import {
  COCKPIT_BROWSER_WORKER,
  COCKPIT_INSTALLATION_WORKER,
  COCKPIT_WORKER_CORE,
  cockpitInstallationWorkerScript,
  joinWorkerSources,
} from "./cockpit-worker.ts";
import type { AppEnv } from "./openapi.ts";
import {
  NEGOTIATED_VARY,
  negotiatedPageResponse,
  renderUnavailablePage,
  resolvePageLook,
  wantsHtmlPage,
} from "./routes/oauth/ui.ts";

export const COCKPIT_PREFIX = "/cockpit";
const COCKPIT_DIR = fileURLToPath(new URL("../../../../assets/cockpit", import.meta.url));
const IMMUTABLE = "public, max-age=31536000, immutable";
const NEVER = "no-cache";
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const CockpitPathSchema = z.object({ path: z.string().min(1) });
const cockpitAssetResponses = {
  200: {
    description: "Cockpit shell or static asset",
    content: { "application/octet-stream": { schema: z.string() } },
  },
  304: { description: "Asset unchanged" },
  503: {
    description: "Cockpit bundle was not included in this deployment",
    content: { "text/html": { schema: z.string() }, "text/plain": { schema: z.string() } },
  },
} as const;
const cockpitCanonicalShellRoute = createRoute({
  method: "get",
  path: "/cockpit",
  operationId: "getCanonicalCockpitShell",
  summary: "Serve the canonical Cockpit application shell",
  responses: cockpitAssetResponses,
});
const cockpitShellRoute = createRoute({
  method: "get",
  path: "/cockpit/",
  operationId: "getCockpitShell",
  summary: "Serve the Cockpit application shell",
  responses: cockpitAssetResponses,
});
const cockpitShellHeadRoute = createRoute({
  method: "head",
  path: "/cockpit/",
  operationId: "headCockpitShell",
  summary: "Inspect the Cockpit application shell",
  responses: cockpitAssetResponses,
});
const cockpitAssetRoute = createRoute({
  method: "get",
  path: "/cockpit/{path}",
  operationId: "getCockpitAsset",
  summary: "Serve the Cockpit shell or an embedded static asset",
  request: { params: CockpitPathSchema },
  responses: cockpitAssetResponses,
});
const cockpitAssetHeadRoute = createRoute({
  method: "head",
  path: "/cockpit/{path}",
  operationId: "headCockpitAsset",
  summary: "Inspect an embedded Cockpit asset",
  request: { params: CockpitPathSchema },
  responses: cockpitAssetResponses,
});

interface Asset {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  etag: string;
}

type CockpitFiles = (relativePath: string) => Uint8Array | null;

function embeddedCockpit(): Readonly<Record<string, string>> {
  try {
    const embedded: {
      EMBEDDED_COCKPIT?: Record<string, string>;
    } = require("./cockpit-embedded.ts");
    return embedded.EMBEDDED_COCKPIT ?? {};
  } catch {
    return {};
  }
}

const EMBEDDED_COCKPIT = embeddedCockpit();

export function cockpitCsp(inlineScriptHashes: readonly string[] = []): string {
  const script = ["script-src 'self'", ...inlineScriptHashes.map((hash) => `'${hash}'`)].join(" ");
  return [
    "default-src 'self'",
    script,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) =>
      `sha256-${createHash("sha256")
        .update(match[1] ?? "", "utf8")
        .digest("base64")}`,
  );
}

const HASHED_ASSET_PREFIX = "assets/";

function bundledCockpitFile(relativePath: string): Uint8Array | null {
  const target = normalize(join(COCKPIT_DIR, relativePath));
  if (target === COCKPIT_DIR || target.startsWith(`${COCKPIT_DIR}${sep}`)) {
    try {
      if (statSync(target).isFile()) return readFileSync(target);
    } catch {}
  }
  const encoded = EMBEDDED_COCKPIT[relativePath];
  return encoded ? Buffer.from(encoded, "base64") : null;
}

function cockpitAssetReader(files: CockpitFiles): (relativePath: string) => Asset | null {
  const cache = new Map<string, Asset>();
  return (relativePath) => {
    const cached = cache.get(relativePath);
    if (cached) return cached;
    const source = files(normalize(relativePath));
    if (!source) return null;
    const body = Uint8Array.from(source);
    const asset = {
      body,
      contentType: MIME[extname(relativePath)] ?? "application/octet-stream",
      etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
    };
    if (normalize(relativePath) === relativePath) cache.set(relativePath, asset);
    return asset;
  };
}

const bundledCockpitAsset = cockpitAssetReader(bundledCockpitFile);

export function cachedCockpitAsset(relativePath: string): Asset | null {
  return bundledCockpitAsset(relativePath);
}

export function cockpitBundleAvailable(): boolean {
  return bundledCockpitAsset("index.html") !== null;
}

function bundledCockpitAssetPaths(): string[] {
  const found = new Set(
    Object.keys(EMBEDDED_COCKPIT).filter((path) => path.startsWith(HASHED_ASSET_PREFIX)),
  );
  try {
    for (const name of readdirSync(join(COCKPIT_DIR, HASHED_ASSET_PREFIX)))
      found.add(`${HASHED_ASSET_PREFIX}${name}`);
  } catch {}
  return [...found].sort();
}

let installationWorker: string | null | undefined;

export function cockpitInstallationWorker(): string | null {
  if (installationWorker !== undefined) return installationWorker;
  const shell = bundledCockpitAsset("index.html");
  const core = bundledCockpitAsset(COCKPIT_WORKER_CORE);
  const worker = bundledCockpitAsset(COCKPIT_INSTALLATION_WORKER);
  installationWorker =
    shell && core && worker
      ? cockpitInstallationWorkerScript({
          shell: shell.body,
          assetPaths: bundledCockpitAssetPaths(),
          sources: [core.body, worker.body],
        })
      : null;
  return installationWorker;
}

export function cockpitSecurityHeaders(csp: string) {
  return {
    "content-security-policy": csp,
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  } as const;
}

export function cockpitBundleMissing(c: Context<AppEnv>): Response {
  if (wantsHtmlPage(c.req.header("accept")))
    return negotiatedPageResponse(
      renderUnavailablePage(resolvePageLook(c.req.raw.headers), "cockpit"),
      503,
    );
  return c.text("the SubKit Cockpit was not built into this deployment\n", 503, {
    ...cockpitSecurityHeaders(cockpitCsp()),
    "cache-control": NEVER,
    vary: NEGOTIATED_VARY,
  });
}

export function registerCockpitRoutes(app: OpenAPIHono<AppEnv>): void {
  registerCockpitRoutesWith(app, bundledCockpitFile);
}

export function registerCockpitRoutesWith(app: OpenAPIHono<AppEnv>, files: CockpitFiles): void {
  const asset = files === bundledCockpitFile ? bundledCockpitAsset : cockpitAssetReader(files);
  const shell = asset("index.html");
  if (!shell) {
    logger.warn({
      module: "http",
      action: "cockpit.bundle_missing",
      msg: "cockpit bundle is not embedded; build:cockpit must run before release",
    });
  }
  const csp = shell
    ? cockpitCsp(inlineScriptHashes(new TextDecoder().decode(shell.body)))
    : cockpitCsp();
  const securityHeaders = cockpitSecurityHeaders(csp);

  const serve = (c: Context<AppEnv>) => {
    if (!shell) return cockpitBundleMissing(c);
    const relative = c.req.path.slice(COCKPIT_PREFIX.length).replace(/^\/+/, "");
    const requested = relative ? asset(relative) : null;
    const hashed = relative.startsWith(HASHED_ASSET_PREFIX);
    if (hashed && !requested)
      return c.text("cockpit asset not found\n", 404, {
        ...securityHeaders,
        "cache-control": NEVER,
      });
    const served = requested ?? shell;
    const headers = {
      ...securityHeaders,
      "cache-control": requested && hashed ? IMMUTABLE : NEVER,
      "content-type": served.contentType,
      etag: served.etag,
    };
    if (c.req.header("if-none-match") === served.etag)
      return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : served.body, { status: 200, headers });
  };

  app.on(["GET", "HEAD"], `${COCKPIT_PREFIX}/sw.js`, (c) => {
    const core = asset(COCKPIT_WORKER_CORE);
    const worker = asset(COCKPIT_BROWSER_WORKER);
    if (!core || !worker) return cockpitBundleMissing(c);
    const script = `${joinWorkerSources([core.body, worker.body])}\n`;
    return new Response(c.req.method === "HEAD" ? null : script, {
      status: 200,
      headers: {
        ...securityHeaders,
        "cache-control": "private, no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  });
  app.openapi(cockpitCanonicalShellRoute, serve);
  app.openapi(cockpitShellRoute, serve);
  app.openapi(cockpitShellHeadRoute, serve);
  app.openapi(cockpitAssetRoute, serve);
  app.openapi(cockpitAssetHeadRoute, serve);
  app.on(["GET", "HEAD"], `${COCKPIT_PREFIX}/:path{.+}`, serve);
}
