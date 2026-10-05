import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];

export type ConnectorTarget = "web" | "mcp";

export type ConnectorSignIn = "account" | "key" | "none";

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

export function needsSecret(signIn: ConnectorSignIn): boolean {
  return signIn === "key";
}

export function needsOAuthClient(target: ConnectorTarget, signIn: ConnectorSignIn): boolean {
  return target === "web" && signIn === "account";
}

const AUTH_TYPE: Record<ConnectorSignIn, CreateConnectorBody["auth_type"]> = {
  account: "oauth2",
  key: "bearer",
  none: "none",
};

const HTTPS = /^https:\/\/\S+\.\S+/;

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

export function afterCreateTab(target: ConnectorTarget): "tools" | "connection" {
  return target === "mcp" ? "tools" : "connection";
}
