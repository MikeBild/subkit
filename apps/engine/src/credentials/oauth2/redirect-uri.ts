import { getConfig } from "../../config/loader.ts";

export const OAUTH_CALLBACK_PATH = "/v1/oauth/callback";

export interface OAuthOriginHints {
  req?: { url: string; headers?: Headers } | Request;
}

export function buildOAuthRedirectUri(hints?: OAuthOriginHints): string | null {
  const origin = resolveOrigin(hints?.req);
  if (!origin) return null;
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

const CONNECTION_CALLBACK_PATH = "/v1/connections/callback";

export function buildConnectionCallbackUri(hints?: OAuthOriginHints): string | null {
  const origin = resolveOrigin(hints?.req);
  if (!origin) return null;
  return `${origin}${CONNECTION_CALLBACK_PATH}`;
}

export function resolvePublicOrigin(hints?: OAuthOriginHints): string | null {
  return resolveOrigin(hints?.req);
}

function resolveOrigin(req?: { url: string; headers?: Headers } | Request): string | null {
  try {
    const cfg = getConfig().server.public_base_url;
    if (cfg && cfg.length > 0) return trimTrailingSlash(cfg);
  } catch {}
  if (req) {
    const headers = (req as Request).headers;
    const fwdProto = headers?.get?.("x-forwarded-proto");
    const fwdHost = headers?.get?.("x-forwarded-host");
    const host = headers?.get?.("host");
    if (fwdHost) {
      const proto = fwdProto ?? safeUrlProto(req.url) ?? "https";
      return `${proto}://${fwdHost}`;
    }
    if (host) {
      const proto = fwdProto ?? safeUrlProto(req.url) ?? "https";
      return `${proto}://${host}`;
    }
    try {
      const origin = new URL(req.url).origin;
      if (origin && origin !== "null") return origin;
    } catch {}
  }
  return null;
}

function safeUrlProto(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
