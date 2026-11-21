import type { components } from "@cli-core/engine-api/openapi";
import { type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";
import { rollingDays, type TimeSpan } from "@/lib/operations-figures";

export type ConnectorRuntime = components["schemas"]["ConnectorRuntime"];
export type CredentialBody = components["schemas"]["CredentialBody"];
export type McpInspect = Omit<components["schemas"]["ConnectorMcpInspectResponse"], "tools"> & {
  tools: (components["schemas"]["ConnectorMcpInspectResponse"]["tools"][number] & {
    input_schema?: Record<string, unknown> | null;
  })[];
};

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mcpTransport(record: Record<string, unknown>): string | null {
  const config = isRecord(record.config) ? record.config : null;
  const mcp = config && isRecord(config.mcp) ? config.mcp : null;
  return mcp && typeof mcp.transport === "string" ? mcp.transport : null;
}

export function toolsWithoutConfirmation(record: Record<string, unknown>): string[] {
  const config = isRecord(record.config) ? record.config : null;
  const mcp = config && isRecord(config.mcp) ? config.mcp : null;
  const list = mcp?.tools_without_confirmation;
  return Array.isArray(list)
    ? [...new Set(list.filter((v): v is string => typeof v === "string"))].sort()
    : [];
}

interface DocLink {
  kind: string;
  url: string;
}

export function documentationLinks(record: Record<string, unknown>): DocLink[] {
  const described = isRecord(record.self_description) ? record.self_description : null;
  const links = Array.isArray(described?.links) ? described.links : [];
  return links.flatMap((link) =>
    isRecord(link) && typeof link.kind === "string" && typeof link.url === "string"
      ? [{ kind: link.kind, url: link.url }]
      : [],
  );
}

const DOC_KIND_KEYS: Record<string, TranslationKey> = {
  llms_txt: "connectorLabel.doc.llms_txt",
  llms_full: "connectorLabel.doc.llms_full",
  openapi: "connectorLabel.doc.openapi",
  graphql: "connectorLabel.doc.graphql",
};

export function docKindLabel(kind: string, t: Translate): CatalogLabel {
  return catalogLabel(kind, DOC_KIND_KEYS[kind], t);
}

export function connectorStatsWindow(now = new Date()): TimeSpan {
  return rollingDays(7, now);
}

interface ConnectorFigures {
  calls: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  medianMs: number | null;
  from: string;
  to: string;
}

export function connectorFigures(envelope: unknown, asked: TimeSpan): ConnectorFigures | null {
  if (!isRecord(envelope) || !isRecord(envelope.totals)) return null;
  const totals = envelope.totals;
  const calls = isRecord(totals.calls) ? totals.calls : null;
  if (!calls || typeof calls.total !== "number") return null;
  const outcome = isRecord(calls.by_outcome) ? calls.by_outcome : {};
  const succeeded = typeof outcome.success === "number" ? outcome.success : 0;
  const failed = typeof outcome.error === "number" ? outcome.error : 0;
  const finished = succeeded + failed;
  const latency = isRecord(totals.latency_ms) ? totals.latency_ms : {};
  const p50 = typeof latency.p50 === "number" ? latency.p50 : 0;
  return {
    calls: calls.total,
    succeeded,
    failed,
    successRate: finished > 0 ? Math.round((succeeded / finished) * 1000) / 10 : null,
    medianMs: calls.total > 0 && p50 > 0 ? p50 : null,
    from: typeof envelope.from === "string" ? envelope.from : asked.from,
    to: typeof envelope.to === "string" ? envelope.to : asked.to,
  };
}

export function asRuntime(value: unknown): ConnectorRuntime | null {
  return isRecord(value) && typeof value.recorded === "boolean"
    ? (value as unknown as ConnectorRuntime)
    : null;
}

export function asInspect(value: unknown): McpInspect | null {
  return isRecord(value) && Array.isArray(value.tools) ? (value as unknown as McpInspect) : null;
}

export function credentialBody(
  authType: string | null,
  secret: string,
  headerName: string,
): CredentialBody | null {
  const value = secret.trim();
  if (!value) return null;
  if (authType === "header") {
    const name = headerName.trim();
    return name ? { mode: "header", headers: { [name]: value } } : null;
  }
  if (authType === "signed_jwt") return { mode: "signed_jwt", private_key: value };
  return { mode: "bearer", token: value };
}

export function offersConnectionChoice(authType: string | null, credentialMode: string | null) {
  return authType === "oauth2" || credentialMode === "connection";
}

export function offersKeyReplacement(authType: string | null): boolean {
  return authType === "header" || authType === "bearer" || authType === "signed_jwt";
}

export const SECRET_MASK = "***redacted***";

export function presentAddress(address: string): { shown: string; keepsSecret: boolean } {
  const keepsSecret = address.includes(SECRET_MASK);
  return { shown: keepsSecret ? address.split(SECRET_MASK).join("•••") : address, keepsSecret };
}

export const SIGNED_IN_PARAM = "signed_in";
export const SIGNIN_FAILED_PARAM = "signin_failed";
const SIGNIN_CODE_PARAM = "signin_code";
const PROVIDER_CODE = /^[a-z0-9_.-]{1,64}$/i;

export type SignInReturn =
  | { kind: "signed_in" }
  | { kind: "signin_failed"; failure: string; code: string | null };

export function signInReturn(search: string): SignInReturn | null {
  const params = new URLSearchParams(search);
  const failure = params.get(SIGNIN_FAILED_PARAM);
  const code = params.get(SIGNIN_CODE_PARAM);
  if (failure !== null)
    return {
      kind: "signin_failed",
      failure,
      code: code !== null && PROVIDER_CODE.test(code) ? code : null,
    };
  return params.has(SIGNED_IN_PARAM) ? { kind: "signed_in" } : null;
}

export function withoutSignInReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SIGNED_IN_PARAM);
  params.delete(SIGNIN_FAILED_PARAM);
  params.delete(SIGNIN_CODE_PARAM);
  const query = params.toString();
  return query ? `?${query}` : "";
}

const SIGN_IN_FAILURE_KEYS = new Map<string, TranslationKey>(
  Object.entries({
    link_expired: "connectorStrip.signInFailure.linkExpired",
    provider_declined: "connectorStrip.signInFailure.providerDeclined",
    no_authorization: "connectorStrip.signInFailure.noAuthorization",
    exchange_failed: "connectorStrip.signInFailure.exchangeFailed",
    issuer_mismatch: "connectorStrip.signInFailure.issuerMismatch",
    connector_gone: "connectorStrip.signInFailure.connectorGone",
    not_startable: "connectorStrip.signInFailure.notStartable",
    no_public_address: "connectorStrip.signInFailure.noPublicAddress",
    unsupported_credential: "connectorStrip.signInFailure.unsupportedCredential",
    missing_field: "connectorStrip.signInFailure.missingField",
    not_saved: "connectorStrip.signInFailure.notSaved",
  } satisfies Record<string, TranslationKey>),
);

export function signInFailureKey(failure: string): TranslationKey {
  return SIGN_IN_FAILURE_KEYS.get(failure) ?? "connectorStrip.signInFailure.other";
}

export function signInFailureLine(
  failed: { failure: string; code: string | null },
  t: Translate,
): string {
  const reason = t(signInFailureKey(failed.failure));
  return failed.code
    ? `${reason} · ${t("connectorStrip.providerCode", { code: failed.code })}`
    : reason;
}

type ConnectorNotice = "signed_in" | "signed_in_off" | "off" | null;

export function connectorNotice(p: {
  enabled: boolean;
  authState: ConnectorAuthState;
  returned: boolean;
}): ConnectorNotice {
  const confirmed = p.returned && !needsRenewal(p.authState) && p.authState !== "not_required";
  if (!p.enabled) return confirmed ? "signed_in_off" : "off";
  return confirmed ? "signed_in" : null;
}

export type RenewalWay = "connection" | "provider" | "key" | null;

export function renewalWay(p: {
  authType: string | null;
  signsInAtProvider: boolean;
  usesConnection: boolean;
  canWrite: boolean;
}): RenewalWay {
  if (!p.canWrite) return null;
  if (p.usesConnection) return "connection";
  if (p.signsInAtProvider) return "provider";
  return offersKeyReplacement(p.authType) ? "key" : null;
}

type Renewable = Exclude<RenewalWay, null>;

const RENEWAL_HINTS: Record<Renewable, TranslationKey> = {
  connection: "connectorCredentials.renewViaConnection",
  provider: "connectorCredentials.renewAtProvider",
  key: "connectorCredentials.renewKey",
};

const FIRST_SIGN_IN_HINTS: Record<Renewable, TranslationKey> = {
  connection: "connectorCredentials.renewViaConnection",
  provider: "connectorCredentials.signInAtProvider",
  key: "connectorCredentials.enterKey",
};

export function signInLine(state: ConnectorAuthState, way: RenewalWay): TranslationKey | null {
  if (state === "expired") return way ? RENEWAL_HINTS[way] : "connectorCredentials.lostReadOnly";
  if (state === "credentials_missing")
    return way ? FIRST_SIGN_IN_HINTS[way] : "connectors.auth.credentialsMissingHint";
  if (state === "unproven") return "connectors.auth.unprovenHint";
  return null;
}

export function connectorConfiguredTimeout(record: Record<string, unknown>): number | null {
  if (record.driver !== "mcp" || !isRecord(record.config) || !isRecord(record.config.mcp))
    return null;
  const value = record.config.mcp.remote_tool_call_timeout_ms;
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 300000
    ? value
    : null;
}

export function connectorConfiguredRuntime(record: Record<string, unknown>) {
  const config = isRecord(record.config) ? record.config : {};
  const http = record.driver === "http";
  const storedTimeout = config.timeout_ms;
  const storedRetries = config.max_retries;
  const timeout = http
    ? typeof storedTimeout === "number" &&
      Number.isFinite(storedTimeout) &&
      storedTimeout > 0 &&
      storedTimeout <= 300000
      ? storedTimeout
      : null
    : connectorConfiguredTimeout(record);
  const retries =
    http &&
    typeof storedRetries === "number" &&
    Number.isInteger(storedRetries) &&
    storedRetries >= 0 &&
    storedRetries <= 5
      ? storedRetries
      : null;
  const snapshot = isRecord(record.template_snapshot) ? record.template_snapshot : {};
  const overridden = config.capabilities !== undefined;
  const capabilities = overridden ? config.capabilities : snapshot.capabilities;
  const rawHints = isRecord(capabilities) ? capabilities.rate_limits : null;
  const rateLimit =
    isRecord(rawHints) &&
    typeof rawHints.requests_per_second === "number" &&
    Number.isFinite(rawHints.requests_per_second) &&
    rawHints.requests_per_second > 0 &&
    typeof rawHints.burst_size === "number" &&
    Number.isInteger(rawHints.burst_size) &&
    rawHints.burst_size > 0 &&
    typeof rawHints.recommended_backoff_ms === "number" &&
    Number.isInteger(rawHints.recommended_backoff_ms) &&
    rawHints.recommended_backoff_ms > 0
      ? {
          requestsPerSecond: rawHints.requests_per_second,
          burstSize: rawHints.burst_size,
          recommendedBackoffMs: rawHints.recommended_backoff_ms,
          source: overridden ? ("provider" as const) : ("template" as const),
        }
      : null;
  return { timeout, timeoutApplied: record.driver === "mcp", retries, rateLimit };
}
