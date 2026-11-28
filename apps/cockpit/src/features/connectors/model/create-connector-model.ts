import type { components } from "@cli-core/engine-api/openapi";
import { addressProblem, isLocalAddress, isLocalHttpsAddress } from "@/lib/connector-address";
import type { TranslationKey } from "@/lib/i18n";
import { type CredentialBody, credentialBody } from "./connector-detail-model";

type CreateConnectorBody = components["schemas"]["CreateConnectorBody"];
type UpdateConnectorBody = components["schemas"]["UpdateConnectorBody"];

export type ConnectorTarget = "web" | "mcp";

export type ConnectorSignIn = "account" | "key" | "none";

export type McpSource = "address" | "command";

export type KeyMode = "bearer" | "header";

export interface EnvVarField {
  name: string;
  value: string;
  secret: boolean;
}

export interface LocalCommandFields {
  command: string;
  args: string;
  env: EnvVarField[];
  cwd: string;
}

export interface TlsFields {
  caPem: string;
  skipVerify: boolean;
}

export const EMPTY_LOCAL_COMMAND: LocalCommandFields = { command: "", args: "", env: [], cwd: "" };

export const EMPTY_TLS: TlsFields = { caPem: "", skipVerify: false };

export const EMPTY_ENV_VAR: EnvVarField = { name: "", value: "", secret: false };

export interface OAuthClientFields {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export interface SignedJwtFields {
  issuer: string;
  keyId: string;
  subject: string;
}

export const EMPTY_SIGNED_JWT: SignedJwtFields = {
  issuer: "",
  keyId: "",
  subject: "",
};

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

export function usesLocalCommand(target: ConnectorTarget, source: McpSource): boolean {
  return target === "mcp" && source === "command";
}

export function defaultSignIn(
  target: ConnectorTarget,
  source: McpSource,
  address: string,
): ConnectorSignIn {
  return usesLocalCommand(target, source) || isLocalAddress(address) ? "none" : DEFAULT_SIGN_IN;
}

export function showsTls(target: ConnectorTarget, source: McpSource, address: string): boolean {
  return !usesLocalCommand(target, source) && isLocalHttpsAddress(address);
}

export function offersHeaderName(target: ConnectorTarget, signIn: ConnectorSignIn): boolean {
  return target === "mcp" && signIn === "key";
}

const TRANSPORT_HEADERS = new Set([
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "host",
  "content-length",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function headerNameProblem(name: string): TranslationKey | null {
  const value = name.trim();
  if (!value) return "create.template.headerMissing";
  if (!HEADER_NAME.test(value)) return "create.connector.headerNameInvalid";
  if (TRANSPORT_HEADERS.has(value.toLowerCase())) return "create.connector.headerNameReserved";
  return null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function argsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function filledEnv(env: readonly EnvVarField[]): EnvVarField[] {
  return env.filter((entry) => entry.name.trim() || entry.value.trim());
}

export function localCommandProblem(fields: LocalCommandFields): TranslationKey | null {
  if (!fields.command.trim()) return "connectorLocal.commandMissing";
  const env = filledEnv(fields.env);
  if (env.some((entry) => !ENV_NAME.test(entry.name.trim())))
    return "connectorLocal.envNameInvalid";
  const names = env.map((entry) => entry.name.trim());
  if (new Set(names).size !== names.length) return "connectorLocal.envNameTwice";
  const cwd = fields.cwd.trim();
  if (cwd && !cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd))
    return "connectorLocal.cwdInvalid";
  return null;
}

function quoted(part: string): string {
  return /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`;
}

export interface CommandLineParts {
  command: string;
  args: readonly string[];
  envNames: readonly string[];
  cwd: string | null;
}

export function commandLine(parts: CommandLineParts): string {
  const env = parts.envNames.map((name) => `${name}=…`);
  const line = [...env, quoted(parts.command), ...parts.args.map(quoted)].join(" ");
  return parts.cwd ? `cd ${quoted(parts.cwd)} && ${line}` : line;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function commandLinePartsOf(config: unknown): CommandLineParts | null {
  const mcp = isRecord(config) && isRecord(config.mcp) ? config.mcp : null;
  if (mcp?.transport !== "stdio" || typeof mcp.command !== "string") return null;
  const env = isRecord(mcp.env) ? Object.keys(mcp.env) : [];
  return {
    command: mcp.command,
    args: stringsOf(mcp.args),
    envNames: [...new Set([...env, ...stringsOf(mcp.env_secret_names)])].sort(),
    cwd: typeof mcp.cwd === "string" && mcp.cwd ? mcp.cwd : null,
  };
}

function engineQuoted(part: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`;
}

export function engineCommandLine(config: unknown): string | null {
  const parts = commandLinePartsOf(config);
  return parts ? [parts.command, ...parts.args].map(engineQuoted).join(" ") : null;
}

export function commandLineOf(config: unknown): string | null {
  const parts = commandLinePartsOf(config);
  return parts ? commandLine(parts) : null;
}

export function localCommandUnconfirmed(config: unknown): boolean {
  if (!commandLinePartsOf(config)) return false;
  const mcp = (config as { mcp: Record<string, unknown> }).mcp;
  return !(typeof mcp.confirmed_command_hash === "string" && mcp.confirmed_command_hash);
}

export function draftCommandLine(fields: LocalCommandFields): string {
  return commandLine({
    command: fields.command.trim(),
    args: argsOf(fields.args),
    envNames: filledEnv(fields.env)
      .map((entry) => entry.name.trim())
      .sort(),
    cwd: fields.cwd.trim() || null,
  });
}

function tlsBlock(tls: TlsFields | undefined): Record<string, unknown> | null {
  if (!tls) return null;
  const pem = tls.caPem.trim();
  if (!pem && !tls.skipVerify) return null;
  return { ...(pem ? { ca_pem: pem } : {}), ...(tls.skipVerify ? { skip_verify: true } : {}) };
}

function hasSecretEnv(fields: LocalCommandFields): boolean {
  return filledEnv(fields.env).some((entry) => entry.secret);
}

function stdioBlock(fields: LocalCommandFields): Record<string, unknown> {
  const env = filledEnv(fields.env);
  const open = env.filter((entry) => !entry.secret);
  const secret = env.filter((entry) => entry.secret).map((entry) => entry.name.trim());
  const cwd = fields.cwd.trim();
  return {
    transport: "stdio",
    auth: { kind: secret.length > 0 ? "header" : "none" },
    command: fields.command.trim(),
    args: argsOf(fields.args),
    ...(open.length > 0
      ? { env: Object.fromEntries(open.map((entry) => [entry.name.trim(), entry.value])) }
      : {}),
    ...(secret.length > 0 ? { env_secret_names: secret } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export function manualCredentialBody(p: {
  target: ConnectorTarget;
  source: McpSource;
  signIn: ConnectorSignIn;
  keyMode: KeyMode;
  header: string;
  secret: string;
  command: LocalCommandFields;
}): CredentialBody | null {
  if (usesLocalCommand(p.target, p.source)) {
    const secret = filledEnv(p.command.env).filter((entry) => entry.secret);
    if (secret.length === 0) return null;
    return {
      mode: "header",
      headers: Object.fromEntries(secret.map((entry) => [entry.name.trim(), entry.value])),
    };
  }
  if (!needsSecret(p.signIn)) return null;
  const header = offersHeaderName(p.target, p.signIn) && p.keyMode === "header";
  return credentialBody(header ? "header" : "bearer", p.secret, header ? p.header : "");
}

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
  source?: McpSource;
  keyMode?: KeyMode;
  command?: LocalCommandFields;
  tls?: TlsFields;
}): CreateConnectorBody {
  const base = {
    name: p.name.trim(),
    slug: p.slug,
    driver: p.target === "mcp" ? ("mcp" as const) : ("http" as const),
    environment: "prod" as const,
  };
  if (usesLocalCommand(p.target, p.source ?? "address")) {
    const command = p.command ?? EMPTY_LOCAL_COMMAND;
    return {
      ...base,
      auth_type: hasSecretEnv(command) ? "header" : "none",
      config: { mcp: stdioBlock(command) },
    };
  }
  const header = offersHeaderName(p.target, p.signIn) && p.keyMode === "header";
  const body: CreateConnectorBody = {
    ...base,
    base_url: p.address.trim(),
    auth_type: header ? "header" : AUTH_TYPE[p.signIn],
  };
  const tls = isLocalHttpsAddress(p.address) ? tlsBlock(p.tls) : null;
  const config: Record<string, unknown> = {
    ...(needsOAuthClient(p.target, p.signIn) && p.oauth ? { oauth: oauthBlock(p.oauth) } : {}),
    ...(tls ? (p.target === "mcp" ? { mcp: { transport: "http", tls } } : { tls }) : {}),
  };
  return Object.keys(config).length > 0 ? { ...body, config } : body;
}

export function manualSourceProblem(p: {
  target: ConnectorTarget;
  source?: McpSource;
  slug: string;
  address: string;
  command?: LocalCommandFields;
}): TranslationKey | null {
  if (!p.slug) return "create.nameMissing";
  if (usesLocalCommand(p.target, p.source ?? "address"))
    return localCommandProblem(p.command ?? EMPTY_LOCAL_COMMAND);
  return addressProblem(p.address, p.target);
}

export function manualConnectorProblem(p: {
  target: ConnectorTarget;
  signIn: ConnectorSignIn;
  slug: string;
  address: string;
  secret: string;
  oauth: OAuthClientFields;
  callbackUrl: string | null;
  source?: McpSource;
  keyMode?: KeyMode;
  header?: string;
  command?: LocalCommandFields;
}): TranslationKey | null {
  const source = manualSourceProblem(p);
  if (source) return source;
  if (usesLocalCommand(p.target, p.source ?? "address")) return null;
  if (offersHeaderName(p.target, p.signIn) && p.keyMode === "header") {
    const header = headerNameProblem(p.header ?? "");
    if (header) return header;
  }
  if (needsSecret(p.signIn) && !p.secret.trim()) return "create.connector.secretMissing";
  if (p.signIn === "account" && !p.callbackUrl) return "signIn.failed.publicUrl";
  if (needsOAuthClient(p.target, p.signIn)) return oauthProblem(p.oauth);
  return null;
}

export function afterCreateTab(target: ConnectorTarget): "tools" | "overview" {
  return target === "mcp" ? "tools" : "overview";
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

function signedJwtOfConfig(config: unknown): Record<string, unknown> {
  return isRecord(config) && isRecord(config.signed_jwt) ? config.signed_jwt : {};
}

export function signedJwtFieldsOf(config: unknown): SignedJwtFields {
  const signedJwt = signedJwtOfConfig(config);
  return {
    issuer: textOf(signedJwt, "issuer"),
    keyId: textOf(signedJwt, "key_id"),
    subject: textOf(signedJwt, "subject"),
  };
}

function signedJwtChanged(prior: SignedJwtFields, draft: SignedJwtFields): boolean {
  return (
    prior.issuer.trim() !== draft.issuer.trim() ||
    prior.keyId.trim() !== draft.keyId.trim() ||
    prior.subject.trim() !== draft.subject.trim()
  );
}

function editedSignedJwtConfig(
  config: unknown,
  signedJwt: SignedJwtFields,
): Record<string, unknown> {
  const prior = signedJwtOfConfig(config);
  const { issuer: _issuer, key_id: _keyId, subject: _subject, ...rest } = prior;
  return {
    ...(isRecord(config) ? config : {}),
    signed_jwt: {
      ...rest,
      ...(signedJwt.issuer.trim() ? { issuer: signedJwt.issuer.trim() } : {}),
      ...(signedJwt.keyId.trim() ? { key_id: signedJwt.keyId.trim() } : {}),
      ...(signedJwt.subject.trim() ? { subject: signedJwt.subject.trim() } : {}),
    },
  };
}

export interface ConnectorEditPrior {
  driver: string | null;
  authType: string | null;
  name: string;
  address: string;
  config: unknown;
  headerNames: readonly string[];
}

export interface ConnectorEditDraft {
  name: string;
  address: string;
  signIn: ConnectorSignIn | null;
  secret: string;
  header: string;
  headerValues: Readonly<Record<string, string>>;
  oauth: OAuthClientFields;
  signedJwt: SignedJwtFields;
}

export function replacesEveryHeader(prior: ConnectorEditPrior): boolean {
  return prior.authType === "header" && prior.headerNames.length > 1;
}

export function missingHeaderValues(
  prior: ConnectorEditPrior,
  draft: ConnectorEditDraft,
): string[] {
  if (!replacesEveryHeader(prior)) return [];
  const empty = prior.headerNames.filter((name) => !(draft.headerValues[name] ?? "").trim());
  return empty.length === prior.headerNames.length ? [] : empty;
}

function everyHeaderBody(
  prior: ConnectorEditPrior,
  draft: ConnectorEditDraft,
): CredentialBody | null {
  const entries = prior.headerNames.map(
    (name) => [name, (draft.headerValues[name] ?? "").trim()] as const,
  );
  if (entries.some(([, value]) => !value)) return null;
  return { mode: "header", headers: Object.fromEntries(entries) };
}

interface ConnectorEditPlan {
  patch: UpdateConnectorBody;
  credential: CredentialBody | null;
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

const addressChanged = (prior: ConnectorEditPrior, draft: ConnectorEditDraft): boolean =>
  Boolean(prior.address) && draft.address.trim() !== prior.address;

export function connectorEditPlan(
  prior: ConnectorEditPrior,
  draft: ConnectorEditDraft,
): ConnectorEditPlan {
  const patch: UpdateConnectorBody = { name: draft.name.trim() };
  if (addressChanged(prior, draft)) patch.base_url = draft.address.trim();
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
    if (
      prior.authType === "signed_jwt" &&
      signedJwtChanged(signedJwtFieldsOf(prior.config), draft.signedJwt)
    )
      patch.config = editedSignedJwtConfig(prior.config, draft.signedJwt);
    return {
      patch,
      credential: replacesEveryHeader(prior)
        ? everyHeaderBody(prior, draft)
        : credentialBody(prior.authType, draft.secret, draft.header),
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
  const target = connectorTargetOf(prior.driver);
  if (addressChanged(prior, draft)) {
    const problem = addressProblem(draft.address, target ?? "web");
    if (problem) return problem;
  }
  const from = signInOf(prior.authType);
  if (!target || draft.signIn === null || draft.signIn === from) {
    if (missingHeaderValues(prior, draft).length > 0) return "connectorEdit.headersIncomplete";
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

const LOCAL_RUN_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  mcp_local_command_unconfirmed: "connectorLocal.error.unconfirmed",
  mcp_stdio_disabled: "connectorLocal.error.stdioDisabled",
  mcp_stdio_unavailable_in_container: "connectorLocal.error.container",
  mcp_stdio_capacity: "connectorLocal.error.capacity",
  mcp_stdio_start_failed: "connectorLocal.error.startFailed",
};

const CONFIRM_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  ...LOCAL_RUN_ERROR_KEYS,
  mcp_local_command_self_confirmation: "connectorLocal.error.selfConfirm",
  self_confirm_not_allowed: "connectorLocal.error.selfConfirm",
  permission_denied: "connectorLocal.error.permission",
  forbidden: "connectorLocal.error.permission",
  mcp_local_command_changed: "connectorLocal.error.changed",
  mcp_not_stdio: "connectorLocal.error.notStdio",
};

const keyIn = (
  map: Readonly<Record<string, TranslationKey>>,
  code: string | null | undefined,
): TranslationKey | null => (code && Object.hasOwn(map, code) ? (map[code] ?? null) : null);

export function localConnectorErrorKey(code: string | null | undefined): TranslationKey | null {
  return keyIn(LOCAL_RUN_ERROR_KEYS, code);
}

export function confirmCommandErrorKey(code: string | null | undefined): TranslationKey | null {
  return keyIn(CONFIRM_ERROR_KEYS, code);
}

export function localCommandCanonical(config: unknown): string | null {
  const mcp = isRecord(config) && isRecord(config.mcp) ? config.mcp : null;
  if (mcp?.transport !== "stdio" || typeof mcp.command !== "string") return null;
  const env: Record<string, string> = {};
  if (isRecord(mcp.env))
    for (const [name, value] of Object.entries(mcp.env))
      if (typeof value === "string") env[name] = value;
  return JSON.stringify({
    command: mcp.command,
    args: stringsOf(mcp.args),
    env: Object.keys(env)
      .sort()
      .map((name) => [name, env[name]]),
    env_secret_names: [...new Set(stringsOf(mcp.env_secret_names))].sort(),
    cwd: typeof mcp.cwd === "string" && mcp.cwd.length > 0 ? mcp.cwd : null,
  });
}

export async function localCommandHash(config: unknown): Promise<string | null> {
  const canonical = localCommandCanonical(config);
  if (canonical === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
