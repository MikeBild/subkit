import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { logger } from "../logging/logger.ts";
import { EMBEDDED_COCKPIT } from "./cockpit-embedded.ts";
import type { AppEnv } from "./openapi.ts";

const COCKPIT_PREFIX = "/cockpit";
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
    content: { "text/plain": { schema: z.string() } },
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

export function cockpitCsp(inlineScriptHashes: readonly string[] = []): string {
  const script = ["script-src 'self'", ...inlineScriptHashes.map((hash) => `'${hash}'`)].join(" ");
  return [
    "default-src 'self'",
    script,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
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

function readAsset(relativePath: string): Asset | null {
  let source: Uint8Array | null = null;
  const target = normalize(join(COCKPIT_DIR, relativePath));
  if (target === COCKPIT_DIR || target.startsWith(`${COCKPIT_DIR}${sep}`)) {
    try {
      if (statSync(target).isFile()) source = readFileSync(target);
    } catch {
      source = null;
    }
  }
  if (!source) {
    const encoded = EMBEDDED_COCKPIT[relativePath];
    if (encoded) source = Buffer.from(encoded, "base64");
  }
  if (!source) return null;
  const body = Uint8Array.from(source);
  return {
    body,
    contentType: MIME[extname(relativePath)] ?? "application/octet-stream",
    etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
  };
}

export function registerCockpitRoutes(app: OpenAPIHono<AppEnv>): void {
  const shell = readAsset("index.html");
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
  const securityHeaders = {
    "content-security-policy": csp,
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  } as const;

  const serve = (c: Context<AppEnv>) => {
    if (!shell) {
      return c.text("the SubKit Cockpit was not built into this deployment\n", 503, {
        ...securityHeaders,
        "cache-control": NEVER,
      });
    }
    const relative = c.req.path.slice(COCKPIT_PREFIX.length).replace(/^\/+/, "");
    const requested = relative ? readAsset(relative) : null;
    const asset = requested ?? shell;
    const headers = {
      ...securityHeaders,
      "cache-control": requested ? IMMUTABLE : NEVER,
      "content-type": asset.contentType,
      etag: asset.etag,
    };
    if (c.req.header("if-none-match") === asset.etag)
      return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : asset.body, { status: 200, headers });
  };

  app.openapi(cockpitCanonicalShellRoute, serve);
  app.openapi(cockpitShellRoute, serve);
  app.openapi(cockpitShellHeadRoute, serve);
  app.openapi(cockpitAssetRoute, serve);
  app.openapi(cockpitAssetHeadRoute, serve);
  app.on(["GET", "HEAD"], `${COCKPIT_PREFIX}/:path{.+}`, serve);
}
