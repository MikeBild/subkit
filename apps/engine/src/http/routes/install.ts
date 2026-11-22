import { isDevBuild } from "@cli-core/release/version.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import installScript from "../../../../../scripts/install.sh" with { type: "text" };
import type { AppEnv } from "../openapi.ts";
import { OPENAPI_INFO } from "../openapi.ts";
import { binariesBundled } from "./install-binary.ts";

const route = createRoute({
  method: "get",
  path: "/install",
  tags: ["install"],
  summary: "Public subkit CLI installer, pinned to this engine's version",
  description:
    "Returns the release installer script with the CLI version pinned to this engine's version. When the engine image bundles the CLI, the script downloads from this engine's /install files; otherwise from the GitHub release of the same version. It verifies the checksums and installs `subkit` to ~/.local/bin.",
  responses: {
    200: {
      description: "Shell script (text/x-shellscript)",
      content: {
        "text/x-shellscript": { schema: z.string() },
      },
    },
  },
});

export interface InstallScriptPins {
  version: string;
  engineUrl: string;
  downloadUrl: string | null;
}

function pinDefault(script: string, name: string, value: string): string {
  const line = `${name}="\${${name}:-`;
  const start = script.indexOf(line);
  if (start === -1) throw new Error(`install script has no ${name} default`);
  const end = script.indexOf("}", start + line.length);
  return `${script.slice(0, start + line.length)}${value}${script.slice(end)}`;
}

export function pinInstallScript(script: string, pins: InstallScriptPins): string {
  const versioned = pinDefault(
    pinDefault(script, "SUBKIT_VERSION", pins.version),
    "SUBKIT_ENGINE_URL",
    pins.engineUrl,
  );
  return pins.downloadUrl
    ? pinDefault(versioned, "SUBKIT_DOWNLOAD_URL", pins.downloadUrl)
    : versioned;
}

const SAFE_HOST = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;
const SAFE_IPV6_HOST = /^\[[0-9a-fA-F:]+\](:\d{1,5})?$/;

function sanitizeBaseUrl(candidate: string): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.host;
  if (!SAFE_HOST.test(host) && !SAFE_IPV6_HOST.test(host)) return null;
  return `${u.protocol}//${host}`;
}

export function registerInstallRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    let configBase = "";
    try {
      const { getConfig } = await import("../../config/loader.ts");
      configBase = getConfig().server.public_base_url ?? "";
    } catch {}
    const reqUrl = new URL(c.req.url);

    const candidates: string[] = [];
    if (configBase) candidates.push(configBase);
    const fwdHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (fwdHost) {
      const proto = c.req.header("x-forwarded-proto") ?? reqUrl.protocol.replace(/:$/, "");
      candidates.push(`${proto}://${fwdHost}`);
    }
    candidates.push(reqUrl.origin);

    let engineBaseUrl = "";
    for (const candidate of candidates) {
      const safe = sanitizeBaseUrl(candidate);
      if (safe) {
        engineBaseUrl = safe;
        break;
      }
    }
    if (!engineBaseUrl) {
      engineBaseUrl = sanitizeBaseUrl(reqUrl.origin) ?? "";
    }

    const body = pinInstallScript(installScript, {
      version: isDevBuild(OPENAPI_INFO.version) ? "latest" : OPENAPI_INFO.version,
      engineUrl: engineBaseUrl,
      downloadUrl: (await binariesBundled()) ? `${engineBaseUrl}/install` : null,
    });
    return c.body(body, 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    });
  });
}

export const _internal = { installScript, sanitizeBaseUrl };
