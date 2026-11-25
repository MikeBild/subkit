import { isDevBuild } from "@cli-core/release/version.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import powershellScript from "../../../../../scripts/install.ps1" with { type: "text" };
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

const powershellRoute = createRoute({
  method: "get",
  path: "/install.ps1",
  tags: ["install"],
  summary: "Public subkit CLI installer for Windows PowerShell, pinned to this engine's version",
  description:
    "Returns the Windows PowerShell installer with the CLI version pinned to this engine's version. It downloads subkit-windows-x64.exe from this engine's /install files or the GitHub release of the same version, verifies the checksums and installs subkit.exe into the user's local programs folder.",
  responses: {
    200: {
      description: "PowerShell script (text/plain)",
      content: {
        "text/plain": { schema: z.string() },
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

function pinPowerShellDefault(script: string, variable: string, value: string): string {
  const line = `if (-not $${variable}) { $${variable} = "`;
  const start = script.indexOf(line);
  if (start === -1) throw new Error(`PowerShell installer has no ${variable} default`);
  const end = script.indexOf('" }', start + line.length);
  const safe = value.replace(/[`"$]/g, "");
  return `${script.slice(0, start + line.length)}${safe}${script.slice(end)}`;
}

export function pinPowerShellScript(script: string, pins: InstallScriptPins): string {
  const versioned = pinPowerShellDefault(
    pinPowerShellDefault(script, "SubkitVersion", pins.version),
    "SubkitEngineUrl",
    pins.engineUrl,
  );
  return pins.downloadUrl
    ? pinPowerShellDefault(versioned, "SubkitDownloadUrl", pins.downloadUrl)
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

async function engineBaseUrlOf(c: Context<AppEnv>): Promise<string> {
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
  for (const candidate of candidates) {
    const safe = sanitizeBaseUrl(candidate);
    if (safe) return safe;
  }
  return sanitizeBaseUrl(reqUrl.origin) ?? "";
}

async function pinsFor(c: Context<AppEnv>): Promise<InstallScriptPins> {
  const engineBaseUrl = await engineBaseUrlOf(c);
  return {
    version: isDevBuild(OPENAPI_INFO.version) ? "latest" : OPENAPI_INFO.version,
    engineUrl: engineBaseUrl,
    downloadUrl: (await binariesBundled()) ? `${engineBaseUrl}/install` : null,
  };
}

export function registerInstallRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) =>
    c.body(pinInstallScript(installScript, await pinsFor(c)), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  app.openapi(powershellRoute, async (c) =>
    c.text(pinPowerShellScript(powershellScript, await pinsFor(c)), 200, {
      "cache-control": "no-store",
    }),
  );
}

export const _internal = { installScript, powershellScript, sanitizeBaseUrl };
