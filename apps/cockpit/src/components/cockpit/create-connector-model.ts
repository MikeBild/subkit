import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];

/**
 * A connector by hand answers two separate questions. First what it connects:
 * a service over its web interface (the `http` driver) or an MCP server.
 */
export type ConnectorTarget = "web" | "mcp";

/**
 * Then how SubKit signs in there: with the reader's own account (OAuth — the
 * service asks them to allow it), with an access key the service hands out,
 * or not at all. Both drivers take all three.
 */
export type ConnectorSignIn = "account" | "key" | "none";

/**
 * The OAuth app a web service signs in through. An MCP server names its own
 * sign-in service and registers SubKit there itself; a web service made by
 * hand has neither, so the reader enters the app they registered at the
 * service: its sign-in service (an OpenID issuer the engine discovers), the
 * client ID and secret it issued, and the scopes to ask for.
 */
export interface OAuthClientFields {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export const EMPTY_OAUTH_CLIENT: OAuthClientFields = {
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "",
};

/** Only a key is typed into the form; an account is approved at the service. */
export function needsSecret(signIn: ConnectorSignIn): boolean {
  return signIn === "key";
}

/** A web service signed in with an account needs its OAuth app's details. */
export function needsOAuthClient(target: ConnectorTarget, signIn: ConnectorSignIn): boolean {
  return target === "web" && signIn === "account";
}

const AUTH_TYPE: Record<ConnectorSignIn, CreateConnectorBody["auth_type"]> = {
  account: "oauth2",
  key: "bearer",
  none: "none",
};

const HTTPS = /^https:\/\/\S+\.\S+/;

/** The create request: the engine's own fields, nothing the form did not ask. */
export function connectorCreateBody(p: {
  target: ConnectorTarget;
  signIn: ConnectorSignIn;
  name: string;
  slug: string;
  address: string;
  oauth?: OAuthClientFields;
}): CreateConnectorBody {
  const body: CreateConnectorBody = {
    name: p.name.trim(),
    slug: p.slug,
    driver: p.target === "mcp" ? "mcp" : "http",
    environment: "prod",
    base_url: p.address.trim(),
    auth_type: AUTH_TYPE[p.signIn],
  };
  if (!needsOAuthClient(p.target, p.signIn) || !p.oauth) return body;
  const secret = p.oauth.clientSecret.trim();
  const scope = p.oauth.scopes
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
  return {
    ...body,
    config: {
      oauth: {
        issuer_url: p.oauth.issuer.trim(),
        client_id: p.oauth.clientId.trim(),
        ...(secret ? { client_secret: secret } : {}),
        ...(scope ? { scope } : {}),
      },
    },
  };
}

/**
 * What stops the form, first problem first; null when it can be sent. An
 * account sign-in that cannot start — the engine has no public address for
 * the service to send the reader back to — is said here, before a connector
 * is made that no one could sign in.
 */
export function manualConnectorProblem(p: {
  target: ConnectorTarget;
  signIn: ConnectorSignIn;
  slug: string;
  address: string;
  secret: string;
  oauth: OAuthClientFields;
  callbackUrl: string | null;
}): TranslationKey | null {
  if (!p.slug) return "create.nameMissing";
  if (!HTTPS.test(p.address.trim())) return "create.connector.addressInvalid";
  if (needsSecret(p.signIn) && !p.secret.trim()) return "create.connector.secretMissing";
  if (p.signIn === "account" && !p.callbackUrl) return "signIn.failed.publicUrl";
  if (needsOAuthClient(p.target, p.signIn)) {
    if (!HTTPS.test(p.oauth.issuer.trim())) return "create.connector.issuerInvalid";
    if (!p.oauth.clientId.trim()) return "create.connector.clientIdMissing";
  }
  return null;
}

/**
 * The tab the reader lands on once the connector exists, when no sign-in
 * leaves the page: an MCP server opens on its tools, a web service on its
 * connection. Whether a sign-in starts is the connector's own answer
 * (`sign_in` on the created connector), not the form's.
 */
export function afterCreateTab(target: ConnectorTarget): "werkzeuge" | "verbindung" {
  return target === "mcp" ? "werkzeuge" : "verbindung";
}
