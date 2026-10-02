// Where a connector sign-in was started, and where its person goes afterwards.
//
// A sign-in leaves the product: the browser goes to the provider and comes
// back to an unauthenticated callback. What that callback says — "return to
// the terminal", "return to the conversation", or nothing at all because the
// browser is sent straight back to the connector's page — depends on where the
// person started. The flow's state row carries that one word.
//
// The word is all it carries. The address a Cockpit flow returns to is built
// here, from the connector id on the state row and the engine's own origin;
// no address a client sent is ever stored or followed.

import { resolvePublicOrigin } from "../credentials/oauth2/redirect-uri.ts";

export const OAUTH_FLOW_ORIGINS = ["cli", "cockpit", "chat", "portal"] as const;
export type OAuthFlowOrigin = (typeof OAUTH_FLOW_ORIGINS)[number];

/**
 * The origin a state row names. A row written before the column existed, or
 * one carrying a word this build does not know, reads as `cli` — the surface
 * every flow had before the others were told apart.
 */
export function oauthFlowOrigin(stored: string | null | undefined): OAuthFlowOrigin {
  return OAUTH_FLOW_ORIGINS.find((origin) => origin === stored) ?? "cli";
}

/** The query flag a Cockpit-started sign-in comes back with. It states no
 *  fact: the page reads the connector again and says what it finds. */
export const SIGNED_IN_MARKER = "signed_in";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The connector's page in the Cockpit, on the engine's own origin — or null
 * when there is no address to build one from.
 *
 * The origin is the configured `server.public_base_url`; without one it is the
 * origin of the flow's own `redirect_uri`, which the engine wrote on the state
 * row when the flow started and which the provider has just sent the browser
 * to. Never the callback request's Host header: that request is
 * unauthenticated, and following it would make this an open redirect.
 */
export function cockpitConnectorUrl(p: {
  connector_id: string;
  /** The `redirect_uri` stored on the flow's state row. */
  redirect_uri: string | null;
  /** Mark the address as the return from a completed sign-in. */
  signed_in?: boolean;
}): string | null {
  if (!UUID.test(p.connector_id)) return null;
  const configured = resolvePublicOrigin();
  // A configured base may carry a path prefix; keep it as written.
  const base = configured
    ? httpOrigin(configured)
      ? configured
      : null
    : httpOrigin(p.redirect_uri);
  if (!base) return null;
  const url = `${base}/cockpit/connectors/${p.connector_id.toLowerCase()}`;
  return p.signed_in ? `${url}?${SIGNED_IN_MARKER}=1` : url;
}
