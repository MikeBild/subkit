import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";
import { credentialBody } from "@/pages/connector-detail-model";

type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];
type UpdateConnectorBody = components["schemas"]["UpdateConnectorBody"];

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

export const DEFAULT_SIGN_IN: ConnectorSignIn = "key";

function oauthBlock(oauth: OAuthClientFields): Record<string, string> {
  const secret = oauth.clientSecret.trim();
  const scope = oauth.scopes
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
  return {
    issuer_url: oauth.issuer.trim(),
    client_id: oauth.clientId.trim(),
    ...(secret ? { client_secret: secret } : {}),
    ...(scope ? { scope } : {}),
  };
}

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
  return { ...body, config: { oauth: oauthBlock(p.oauth) } };
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
  if (needsOAuthClient(p.target, p.signIn)) return oauthProblem(p.oauth);
  return null;
}

export function afterCreateTab(target: ConnectorTarget): "tools" | "connection" {
  return target === "mcp" ? "tools" : "connection";
}

export function connectorTargetOf(driver: string | null): ConnectorTarget | null {
  if (driver === "http") return "web";
  if (driver === "mcp") return "mcp";
  return null;
}

const SIGN_IN_OF: Readonly<Record<string, ConnectorSignIn>> = {
  none: "none",
  bearer: "key",
  oauth2: "account",
};

export function signInOf(authType: string | null): ConnectorSignIn | null {
  return authType && Object.hasOwn(SIGN_IN_OF, authType) ? (SIGN_IN_OF[authType] ?? null) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oauthOf(config: unknown): Record<string, unknown> {
  return isRecord(config) && isRecord(config.oauth) ? config.oauth : {};
}

const textOf = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

export function oauthClientOf(config: unknown): OAuthClientFields {
  const oauth = oauthOf(config);
  return {
    issuer: textOf(oauth, "issuer_url"),
    clientId: textOf(oauth, "client_id"),
    clientSecret: "",
    scopes: textOf(oauth, "scope"),
  };
}

export interface ConnectorEditPrior {
  driver: string | null;
  authType: string | null;
  name: string;
  address: string;
  config: unknown;
}

export interface ConnectorEditDraft {
  name: string;
  address: string;
  signIn: ConnectorSignIn | null;
  secret: string;
  header: string;
  oauth: OAuthClientFields;
}

export interface ConnectorEditPlan {
  patch: UpdateConnectorBody;
  credential: Record<string, unknown> | null;
  startSignIn: boolean;
}

function oauthChanged(prior: OAuthClientFields, draft: OAuthClientFields): boolean {
  return (
    prior.issuer.trim() !== draft.issuer.trim() ||
    prior.clientId.trim() !== draft.clientId.trim() ||
    prior.scopes.trim() !== draft.scopes.trim() ||
    draft.clientSecret.trim() !== ""
  );
}

function editedOAuthConfig(config: unknown, oauth: OAuthClientFields): Record<string, unknown> {
  const prior = oauthOf(config);
  const sameIssuer = textOf(prior, "issuer_url") === oauth.issuer.trim();
  const fresh = oauthBlock(oauth);
  const { scope: _scope, ...kept } = sameIssuer ? prior : {};
  return { ...(isRecord(config) ? config : {}), oauth: { ...kept, ...fresh } };
}

export function connectorEditPlan(
  prior: ConnectorEditPrior,
  draft: ConnectorEditDraft,
): ConnectorEditPlan {
  const patch: UpdateConnectorBody = { name: draft.name.trim() };
  if (prior.address && draft.address.trim() !== prior.address)
    patch.base_url = draft.address.trim();
  const target = connectorTargetOf(prior.driver);
  const from = signInOf(prior.authType);
  const to = target ? draft.signIn : from;
  if (to === null || to === from) {
    const editsClient =
      to === "account" &&
      target !== null &&
      needsOAuthClient(target, to) &&
      oauthChanged(oauthClientOf(prior.config), draft.oauth);
    if (editsClient) patch.config = editedOAuthConfig(prior.config, draft.oauth);
    return {
      patch,
      credential: credentialBody(prior.authType, draft.secret, draft.header),
      startSignIn: false,
    };
  }
  if (to === "key")
    return { patch, credential: credentialBody("bearer", draft.secret, ""), startSignIn: false };
  if (to === "none")
    return { patch: { ...patch, auth_type: "none" }, credential: null, startSignIn: false };
  return {
    patch: {
      ...patch,
      auth_type: "oauth2",
      ...(target && needsOAuthClient(target, to)
        ? { config: editedOAuthConfig(prior.config, draft.oauth) }
        : {}),
    },
    credential: null,
    startSignIn: true,
  };
}

export function connectorEditProblem(
  prior: ConnectorEditPrior,
  draft: ConnectorEditDraft,
  callbackUrl: string | null,
): TranslationKey | null {
  if (!draft.name.trim()) return "create.nameMissing";
  if (prior.address && !HTTPS.test(draft.address.trim())) return "create.connector.addressInvalid";
  const target = connectorTargetOf(prior.driver);
  const from = signInOf(prior.authType);
  if (!target || draft.signIn === null || draft.signIn === from) {
    if (draft.signIn === "account" && target && needsOAuthClient(target, "account"))
      return oauthProblem(draft.oauth);
    return null;
  }
  if (draft.signIn === "key" && !draft.secret.trim()) return "create.connector.secretMissing";
  if (draft.signIn === "account") {
    if (!callbackUrl) return "signIn.failed.publicUrl";
    if (needsOAuthClient(target, "account")) return oauthProblem(draft.oauth);
  }
  return null;
}

function oauthProblem(oauth: OAuthClientFields): TranslationKey | null {
  if (!HTTPS.test(oauth.issuer.trim())) return "create.connector.issuerInvalid";
  if (!oauth.clientId.trim()) return "create.connector.clientIdMissing";
  return null;
}
