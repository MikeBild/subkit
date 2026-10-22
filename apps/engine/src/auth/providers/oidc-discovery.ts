import * as oauth from "openid-client";
import { logger } from "../../logging/logger.ts";

export async function loadOidcConfiguration(
  issuerUrl: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<oauth.Configuration> {
  const url = new URL(issuerUrl);
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV === "production") {
      logger.warn({
        msg: "OIDC issuer uses insecure HTTP — authorization codes may be intercepted",
        issuer: issuerUrl,
      });
    }
  }
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    url.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};
  const configuration = await oauth.discovery(
    url,
    clientId,
    clientSecret,
    undefined,
    discoveryOptions,
  );
  if (url.protocol === "http:") {
    oauth.allowInsecureRequests(configuration);
  }
  return configuration;
}

export async function oidcEndSessionUrl(opts: {
  issuerUrl: string;
  clientId: string;
  postLogoutRedirectUri: string;
}): Promise<string | null> {
  try {
    const configuration = await loadOidcConfiguration(opts.issuerUrl, opts.clientId, undefined);
    if (!configuration.serverMetadata().end_session_endpoint) return null;
    return oauth
      .buildEndSessionUrl(configuration, { post_logout_redirect_uri: opts.postLogoutRedirectUri })
      .toString();
  } catch (err) {
    logger.warn({
      module: "auth",
      action: "oidc.end_session_unavailable",
      msg: "identity provider logout URL could not be resolved",
      issuer: opts.issuerUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
