import { resolvePublicOrigin } from "../credentials/oauth2/redirect-uri.ts";

export const OAUTH_FLOW_ORIGINS = ["cli", "cockpit", "chat", "portal"] as const;
export type OAuthFlowOrigin = (typeof OAUTH_FLOW_ORIGINS)[number];

export function oauthFlowOrigin(stored: string | null | undefined): OAuthFlowOrigin {
  return OAUTH_FLOW_ORIGINS.find((origin) => origin === stored) ?? "cli";
}

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

export function cockpitConnectorUrl(p: {
  connector_id: string;
  redirect_uri: string | null;
  signed_in?: boolean;
}): string | null {
  if (!UUID.test(p.connector_id)) return null;
  const configured = resolvePublicOrigin();
  const base = configured
    ? httpOrigin(configured)
      ? configured
      : null
    : httpOrigin(p.redirect_uri);
  if (!base) return null;
  const url = `${base}/cockpit/connectors/${p.connector_id.toLowerCase()}`;
  return p.signed_in ? `${url}?${SIGNED_IN_MARKER}=1` : url;
}
