// Canonical OAuth2 redirect URI synthesis.
//
// One callback URL per engine instance (not per connector). The
// authorization-code dance correlates connector + tenant via the
// opaque `state` parameter, which the engine generates server-side
// and persists in `connector_oauth_states`. The OAuth provider only
// ever sees this single URL — operators add it to their provider's
// allowlist exactly once and reuse it for every OAuth2 connector.
//
// Resolution precedence (mirrors apps/engine/src/http/routes/install.ts):
//   1) `server.public_base_url` from the runtime config — the
//      operator-canonical answer when the engine sits behind a proxy
//      that doesn't reliably forward Host/X-Forwarded-Host. v3.5+ this
//      is the ONLY persistent source; the legacy env override moved to
//      the retired list (env.ts:RETIRED_ENV_KEYS).
//   2) `x-forwarded-proto` + `x-forwarded-host` headers — populated
//      by Caddy/Traefik/nginx when configured to do so. Important
//      because `new URL(req.url).origin` on the bun runtime gives
//      `http://localhost:3000` even on a TLS-terminating proxy host.
//   3) `host` header + `req.url`'s protocol — for direct-hit deploys.
//   4) `new URL(req.url).origin` — last resort.
//   5) `null` — caller must surface a typed `engine_public_url_missing`.
//
// Pre-fix the engine had a per-connector callback path
// (`/v1/connectors/{id}/oauth/callback`) and the LLM was expected to
// author the `redirect_uri` on the connector config. The LLM almost
// always got it wrong (`http://` instead of `https://`, wrong path
// segment); operators also had to copy a per-connector UUID into
// their OAuth provider's allowlist — neither is workable. The
// reference impl uses a single global `/api/auth/callback` with the
// `state` carrying everything needed; this module brings subkit to
// the same shape.

import { getConfig } from "../../config/loader.ts";

/** Canonical path for the global OAuth2 callback route. */
export const OAUTH_CALLBACK_PATH = "/v1/oauth/callback";

export interface OAuthOriginHints {
  /** The live request, when available. Used for header inspection and
   *  as the lowest-precedence fallback origin. */
  req?: { url: string; headers?: Headers } | Request;
}

/**
 * Build the canonical OAuth2 redirect URI the engine accepts. See the
 * precedence list at the top of this file. Returns `null` when no
 * source resolves — the caller must surface a typed error instead of
 * inventing a host.
 */
export function buildOAuthRedirectUri(hints?: OAuthOriginHints): string | null {
  const origin = resolveOrigin(hints?.req);
  if (!origin) return null;
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

function resolveOrigin(req?: { url: string; headers?: Headers } | Request): string | null {
  // 1) Configured public_base_url — operator-canonical.
  try {
    const cfg = getConfig().server.public_base_url;
    if (cfg && cfg.length > 0) return trimTrailingSlash(cfg);
  } catch {
    /* loader not initialised — fall through to request-derived inference */
  }
  // 2-4) Live request inference.
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
    } catch {
      /* fall through */
    }
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
