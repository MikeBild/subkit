import type { components } from "@/api/schema";
import { auditHref } from "@/app/links";
import { type ConnectorAuthState, needsRenewal } from "@/lib/connector-auth-state";
import type { TranslationKey } from "@/lib/i18n";
import { type CatalogLabel, catalogLabel } from "@/lib/machine-label";
import { type WindowBounds, windowBounds } from "./operations-figures";

// What the connector detail page says about a connector, decided here and not
// in the component: the words for the engine's machine values, the runtime
// figures over one fixed window, the audit links that count the same thing,
// the credential body a replaced key is posted as, what the page says when a
// sign-in comes back from the provider, and which one action the sign-in card
// offers.

export type ConnectorRuntime = components["schemas"]["ConnectorRuntime"];
export type McpInspect = components["schemas"]["ConnectorMcpInspectResponse"];

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Label maps ───────────────────────────────────────────────────────────────
//
// One map per machine vocabulary, shared by the detail page and the connector
// list, so the list's "Treiber" column and the page's "Art" say the same word.
// A value this build has no word for is shown as "Andere (<raw>)" — the
// engine's own value, named as one, never "Unbekannt" (§2).

const DRIVER_KEYS: Record<string, TranslationKey> = {
  http: "connectorLabel.driver.http",
  graphql: "connectorLabel.driver.graphql",
  mcp: "connectorLabel.driver.mcp",
  postgres: "connectorLabel.driver.postgres",
  s3: "connectorLabel.driver.s3",
};

const TRANSPORT_KEYS: Record<string, TranslationKey> = {
  http: "connectorLabel.transport.http",
  sse: "connectorLabel.transport.sse",
  stdio: "connectorLabel.transport.stdio",
};

const ENVIRONMENT_KEYS: Record<string, TranslationKey> = {
  prod: "connectorLabel.environment.prod",
  dev: "connectorLabel.environment.dev",
};

const AUTH_KEYS: Record<string, TranslationKey> = {
  none: "connectorLabel.auth.none",
  header: "connectorLabel.auth.header",
  query: "connectorLabel.auth.query",
  bearer: "connectorLabel.auth.bearer",
  basic: "connectorLabel.auth.basic",
  oauth2: "connectorLabel.auth.oauth2",
  oauth2_client: "connectorLabel.auth.oauth2_client",
  oauth2_private_key: "connectorLabel.auth.oauth2_private_key",
  aws_sigv4: "connectorLabel.auth.aws_sigv4",
};

function mapped(map: Record<string, TranslationKey>, raw: string | null, t: Translate): string {
  if (raw === null || raw === "") return "";
  const key = map[raw];
  return key ? t(key) : t("connectorLabel.other", { raw });
}

export function driverLabel(raw: string | null, t: Translate): string {
  return mapped(DRIVER_KEYS, raw, t);
}

export function transportLabel(raw: string | null, t: Translate): string {
  return mapped(TRANSPORT_KEYS, raw, t);
}

export function environmentLabel(raw: string | null, t: Translate): string {
  return mapped(ENVIRONMENT_KEYS, raw, t);
}

/**
 * How the connector signs in, as a sentence. A header credential names its
 * header ("Schlüssel im Header X-API-KEY") — the name, never the value; one
 * whose header the engine did not report still says where the key goes.
 */
export function authLabel(
  authType: string | null,
  headerNames: readonly string[],
  t: Translate,
): string {
  if (authType === "header") {
    return headerNames.length > 0
      ? t("connectorLabel.auth.header", { name: headerNames.join(", ") })
      : t("connectorLabel.auth.headerUnnamed");
  }
  return mapped(AUTH_KEYS, authType, t);
}

/** The MCP transport the connector declares, when it declares one. */
export function mcpTransport(record: Record<string, unknown>): string | null {
  const config = isRecord(record.config) ? record.config : null;
  const mcp = config && isRecord(config.mcp) ? config.mcp : null;
  return mcp && typeof mcp.transport === "string" ? mcp.transport : null;
}

/** The remote tools an operator lets run without asking, as stored on the connector. */
export function toolsWithoutConfirmation(record: Record<string, unknown>): string[] {
  const config = isRecord(record.config) ? record.config : null;
  const mcp = config && isRecord(config.mcp) ? config.mcp : null;
  const list = mcp?.tools_without_confirmation;
  return Array.isArray(list)
    ? [...new Set(list.filter((v): v is string => typeof v === "string"))].sort()
    : [];
}

export interface DocLink {
  kind: string;
  url: string;
}

/** The connector's published self-description links (llms.txt, OpenAPI, …). */
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

// ── Runtime over one window ──────────────────────────────────────────────────

/** The page reads its figures over the last seven days, fixed once per read. */
export function connectorStatsWindow(now = new Date()): WindowBounds {
  return windowBounds("7d", now);
}

export function connectorStatsEndpoint(connectorId: string, bounds: WindowBounds): string {
  return `/v1/stats/connectors?bucket=day&from=${encodeURIComponent(bounds.from)}&to=${encodeURIComponent(bounds.to)}&connector_id=${encodeURIComponent(connectorId)}`;
}

export interface ConnectorFigures {
  /** Every recorded call in the window. */
  calls: number;
  succeeded: number;
  failed: number;
  /** succeeded / (succeeded + failed); null when nothing finished either way.
   *  A call the user stopped (`denied`) is in `calls` and in neither side. */
  successRate: number | null;
  /** Median latency in ms; null when no call carried one. */
  medianMs: number | null;
  /** The bounds the engine actually counted over (it may clamp `from`). */
  from: string;
  to: string;
}

/** The figures from a `/v1/stats/connectors` envelope, or null when it is not one. */
export function connectorFigures(envelope: unknown, asked: WindowBounds): ConnectorFigures | null {
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

/**
 * The audit log narrowed to this connector's calls over the figures' own
 * window (§10.1). An mcp call is the pool's `mcp_external_tool.invoked` row;
 * every other driver's call is the egress row `connector.invoked` — the same
 * rows the engine's figures counted. A counted zero has nothing to open.
 */
export function connectorCallsHref(
  connectorId: string,
  driver: string | null,
  figures: ConnectorFigures,
  only: "all" | "failed",
): string | null {
  const count = only === "failed" ? figures.failed : figures.calls;
  if (count === 0) return null;
  const mcp = driver === "mcp";
  return auditHref({
    resourceType: mcp ? "mcp_external_tool" : "connector",
    resourceId: connectorId,
    actions: [mcp ? "mcp_external_tool.invoked" : "connector.invoked"],
    tsFrom: figures.from,
    tsTo: figures.to,
    result: only === "failed" ? "error" : null,
  });
}

/** A runtime answer, or null when the body is not one (a fixture's catch-all). */
export function asRuntime(value: unknown): ConnectorRuntime | null {
  return isRecord(value) && typeof value.recorded === "boolean"
    ? (value as unknown as ConnectorRuntime)
    : null;
}

/** An inspect answer, or null when the body is not one. */
export function asInspect(value: unknown): McpInspect | null {
  return isRecord(value) && Array.isArray(value.tools) ? (value as unknown as McpInspect) : null;
}

// ── Replacing a key ──────────────────────────────────────────────────────────

/**
 * The credential body a replaced key is posted as — the mode the connector
 * actually signs in with. The card used to post every key as `bearer`, so a
 * connector that sends its key in `X-API-KEY` was silently switched to an
 * `Authorization: Bearer` header and stopped signing in.
 */
export function credentialBody(
  authType: string | null,
  secret: string,
  headerName: string,
): Record<string, unknown> | null {
  const value = secret.trim();
  if (!value) return null;
  if (authType === "header") {
    const name = headerName.trim();
    return name ? { mode: "header", headers: { [name]: value } } : null;
  }
  return { mode: "bearer", token: value };
}

/** "Verbindung wählen" is a way to sign in only where a connection can carry it. */
export function offersConnectionChoice(authType: string | null, credentialMode: string | null) {
  return authType === "oauth2" || credentialMode === "connection";
}

/** A key can be replaced for the kinds of sign-in that take one pasted value. */
export function offersKeyReplacement(authType: string | null): boolean {
  return authType === "header" || authType === "bearer";
}

/** What the engine puts where a connector representation keeps a value secret. */
export const SECRET_MASK = "***redacted***";

/**
 * A connector address for display. The engine masks a credential inside it —
 * a password in the user part, a key in the query — with a fixed marker. That
 * marker is not part of the address: shown as written it reads as a literal
 * value, and copied it is an address that cannot work. The secret reads as
 * kept (`•••`), and an address that carries one is not offered for copying.
 */
export function presentAddress(address: string): { shown: string; keepsSecret: boolean } {
  const keepsSecret = address.includes(SECRET_MASK);
  return { shown: keepsSecret ? address.split(SECRET_MASK).join("•••") : address, keepsSecret };
}

// ── Coming back from a sign-in ────────────────────────────────────────────────

/**
 * The flag the engine's sign-in callback returns to this page with. It states
 * no fact — anyone can type it into an address. The page reads the connector
 * again and says what it finds; the flag only says "say it once".
 */
export const SIGNED_IN_PARAM = "signed_in";

export function returnedFromSignIn(search: string): boolean {
  return new URLSearchParams(search).has(SIGNED_IN_PARAM);
}

/** The address without the flag, so a reload does not repeat the sentence. */
export function withoutSignInReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SIGNED_IN_PARAM);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The one statement above the page's sections, and whether it carries the
 * page's act for a switched-off connector.
 *
 * Switched off is not the same as needing a sign-in: signing in never switches
 * a connector on, so a connector can be signed in and off at once — and the
 * page has to say both, with the one act that changes it.
 *
 *   signed_in      came back from the provider, and the connector agrees
 *   signed_in_off  the same, and it is still switched off
 *   off            switched off, nothing to confirm
 *
 * A return flag the connector does not bear out — its sign-in still reads as
 * lost — confirms nothing.
 */
export type ConnectorNotice = "signed_in" | "signed_in_off" | "off" | null;

export function connectorNotice(p: {
  enabled: boolean;
  authState: ConnectorAuthState;
  /** The page was opened by the sign-in callback's redirect. */
  returned: boolean;
}): ConnectorNotice {
  const confirmed = p.returned && !needsRenewal(p.authState) && p.authState !== "not_required";
  if (!p.enabled) return confirmed ? "signed_in_off" : "off";
  return confirmed ? "signed_in" : null;
}

/**
 * The way a lost sign-in is renewed — the one act the sign-in card offers for
 * it, chosen by how the connector signs in. Null when the reader has none:
 * no write permission, or a kind of sign-in this page cannot renew.
 *
 *   connection  the sign-in rides on an account connection; renewed there
 *   provider    the connector's own sign-in at the provider (leaves the page
 *               and comes back)
 *   key         a stored key, replaced in the card
 */
export type RenewalWay = "connection" | "provider" | "key" | null;

export function renewalWay(p: {
  authType: string | null;
  usesConnection: boolean;
  canWrite: boolean;
}): RenewalWay {
  if (!p.canWrite) return null;
  if (p.usesConnection) return "connection";
  if (p.authType === "oauth2") return "provider";
  return offersKeyReplacement(p.authType) ? "key" : null;
}

type Renewable = Exclude<RenewalWay, null>;

// What the button beside the line does, per state: a refused sign-in is
// renewed, a missing one is made for the first time.
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

/**
 * The card's one line under its title. A lost sign-in with a way to renew it
 * says what is the case and what the button beside it does; the state's own
 * sentence stands only where there is no such button to explain. A sign-in
 * that works needs no sentence: the badge says it.
 */
export function signInLine(state: ConnectorAuthState, way: RenewalWay): TranslationKey | null {
  if (state === "expired") return way ? RENEWAL_HINTS[way] : "connectorCredentials.lostReadOnly";
  if (state === "credentials_missing")
    return way ? FIRST_SIGN_IN_HINTS[way] : "connectors.auth.credentialsMissingHint";
  if (state === "unproven") return "connectors.auth.unprovenHint";
  return null;
}

/** The button's word: a first sign-in is not "again". */
export function signInActionLabel(state: ConnectorAuthState): TranslationKey {
  return state === "credentials_missing"
    ? "connectorCredentials.signIn"
    : "connectorCredentials.renew";
}
