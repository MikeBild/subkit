import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cockpitInstallationIdFromPath } from "../auth/browser-session.ts";
import { getTenant } from "../identity/service.ts";
import { getTenantBranding, getTenantBrandingAppIcon } from "../identity/tenant-branding.ts";
import {
  cachedCockpitAsset,
  cockpitBundleMissing,
  cockpitCsp,
  cockpitSecurityHeaders,
  inlineScriptHashes,
} from "./cockpit.ts";
import { resolveCockpitInstallationContext } from "./middleware/cockpit-installation.ts";
import type { AppEnv } from "./openapi.ts";

const PRIVATE = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
};
const PALETTE_COLORS = { standard: "#2563eb", indigo: "#4f46e5", teal: "#0f766e" };

export function registerCockpitInstallationAssets(app: OpenAPIHono<AppEnv>): void {
  app.get("/cockpit/i/:installationId/manifest.webmanifest", async (c) => {
    const context = await resolveCockpitInstallationContext(
      c.get("db"),
      c.req.raw,
      c.get("principal"),
    );
    if (!context) return c.json({ code: "installation_session_required" }, 401, PRIVATE);
    const branding = await getTenantBranding(context.tenant_id, c.get("db"));
    const base = `/cockpit/i/${context.installation_id}/`;
    const tenant = await getTenant(context.tenant_id, c.get("db"));
    const name = tenant?.display_name || "SubKit";
    const icons = ([192, 512] as const).map((size) => ({
      src: `${base}icon/${size}.png?revision=${branding.revision}`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    }));
    return c.json(
      {
        id: base,
        name,
        short_name: name,
        start_url: base,
        scope: base,
        display: "standalone",
        background_color: "#ffffff",
        theme_color: PALETTE_COLORS[branding.palette ?? "standard"],
        icons,
        file_handlers: [
          {
            action: `${base}incoming/files`,
            accept: {
              "text/plain": [".txt", ".md"],
              "text/csv": [".csv"],
              "application/json": [".json"],
              "application/pdf": [".pdf"],
            },
          },
        ],
        share_target: {
          action: `${base}incoming/share`,
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "files",
                accept: ["text/plain", "text/csv", "application/json", "application/pdf"],
              },
            ],
          },
        },
      },
      200,
      { ...PRIVATE, "content-type": "application/manifest+json" },
    );
  });

  app.get("/cockpit/i/:installationId/icon/:size", async (c) => {
    const context = await resolveCockpitInstallationContext(
      c.get("db"),
      c.req.raw,
      c.get("principal"),
    );
    const size =
      c.req.param("size") === "192.png" ? 192 : c.req.param("size") === "512.png" ? 512 : null;
    const revision = Number(c.req.query("revision"));
    if (!context || !size || !Number.isSafeInteger(revision) || revision < 0)
      return c.body(null, 404, PRIVATE);
    const branding = await getTenantBranding(context.tenant_id, c.get("db"));
    if (branding.revision !== revision) return c.body(null, 404, PRIVATE);
    const icon = await getTenantBrandingAppIcon(context.tenant_id, revision, size, c.get("db"));
    const fallback = cachedCockpitAsset(`app-icon-${size}.png`);
    const body = icon ?? fallback?.body;
    if (!body) return cockpitBundleMissing(c);
    return new Response(Buffer.from(body), {
      headers: { ...PRIVATE, "content-type": "image/png" },
    });
  });

  app.get("/cockpit/i/:installationId/sw.js", (c) => {
    if (!cockpitInstallationIdFromPath(c.req.path)) return c.body(null, 404, PRIVATE);
    const script = cachedCockpitAsset("installation-worker.js");
    if (!script) return cockpitBundleMissing(c);
    return new Response(script.body, {
      headers: {
        ...PRIVATE,
        "content-type": "application/javascript; charset=utf-8",
        "service-worker-allowed": `/cockpit/i/${c.req.param("installationId")}/`,
      },
    });
  });

  app.post("/cockpit/i/:installationId/incoming/share", (c) =>
    c.text("Open the app, sign in and share again.", 409, PRIVATE),
  );

  const shell = (c: Context<AppEnv>) => {
    if (!cockpitInstallationIdFromPath(c.req.path)) return c.body(null, 404, PRIVATE);
    const asset = cachedCockpitAsset("index.html");
    if (!asset) return cockpitBundleMissing(c);
    const html = new TextDecoder().decode(asset.body);
    return new Response(c.req.method === "HEAD" ? null : html, {
      headers: {
        ...cockpitSecurityHeaders(cockpitCsp(inlineScriptHashes(html))),
        ...PRIVATE,
        "content-type": "text/html; charset=utf-8",
      },
    });
  };
  app.on(["GET", "HEAD"], "/cockpit/i/:installationId", shell);
  app.on(["GET", "HEAD"], "/cockpit/i/:installationId/*", (c) => {
    const path = c.req.path;
    if (path.includes("/api/") || /\.(?:js|png|webmanifest)$/.test(path))
      return c.body(null, 404, PRIVATE);
    return shell(c);
  });
}
