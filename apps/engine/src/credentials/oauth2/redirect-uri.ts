// Canonical OAuth2 redirect URI synthesis.
//
// One callback URL per engine instance (not per connector). The
// authorization-code dance correlates connector + tenant via the
// opaque `state` parameter, which the engine generates server-side
// and persists in `connector_oauth_states`. The OAuth provider only
// ever sees this single URL — operators add it to their provider's
// allowlist exactly once and reuse it for every OAuth2 connector.
//
// Pre-fix the engine had a per-connector callback path
// (`/v1/connectors/{id}/oauth/callback`) and the LLM was expected to
// author the `redirect_uri` on the connector config. The LLM almost
// always got it wrong (`http://` instead of `https://`, wrong path
// segment), and the operator had to copy a per-connector UUID into
// their OAuth provider's allowlist — neither is workable. The
// reference impl uses a single global `/api/auth/callback` with the
// `state` carrying everything needed; this module brings subkit to
// the same shape.

import { getConfig } from "../../config/loader.ts";

/** Canonical path for the global OAuth2 callback route. */
export const OAUTH_CALLBACK_PATH = "/v1/oauth/callback";

/**
 * Build the canonical OAuth2 redirect URI the engine accepts. Prefers
 * the live request's origin (multi-host deploys, port-forwarded dev
 * loops) and falls back to the configured `server.public_base_url`,
 * then the `SUBKIT_PUBLIC_BASE_URL` env override. Returns `null` when
 * none of the three resolve — the caller must surface a typed error
 * instead of inventing a host.
 */
export function buildOAuthRedirectUri(req?: { url: string } | Request): string | null {
  const origin = resolveOrigin(req);
  if (!origin) return null;
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

function resolveOrigin(req?: { url: string } | Request): string | null {
  if (req) {
    try {
      const origin = new URL(req.url).origin;
      if (origin && origin !== "null") return origin;
    } catch {
      /* fall through */
    }
  }
  try {
    const cfg = getConfig().server.public_base_url;
    if (cfg && cfg.length > 0) return trimTrailingSlash(cfg);
  } catch {
    /* loader not initialised */
  }
  const envFallback = process.env.SUBKIT_PUBLIC_BASE_URL;
  if (envFallback && envFallback.length > 0) return trimTrailingSlash(envFallback);
  return null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
