export const OAUTH_CALLBACK_PATH = "/v1/oauth/callback";
export const SIGNIN_FINISHED_EVENT = "connector.oauth.signin_finished";

export type SheetPhase = "open" | "succeeded" | "failed";

export interface BrowserSheet {
  url: string;
  host: string;
  secure: boolean;
  connectorId: string | null;
  connectorName: string | null;
  phase: SheetPhase;
  reason: string | null;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isConnectorSignIn(raw: string, serverOrigin: string): boolean {
  const url = parse(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  if (url.searchParams.get("response_type") !== "code") return false;
  if (!url.searchParams.get("client_id")) return false;
  const redirect = parse(url.searchParams.get("redirect_uri") ?? "");
  return Boolean(
    redirect && redirect.origin === serverOrigin && redirect.pathname === OAUTH_CALLBACK_PATH,
  );
}

const CONNECTOR_PAGE = /\/connectors\/([A-Za-z0-9_-]{1,128})(?:[/?#]|$)/;

export function connectorIdFromPage(raw: string | null): string | null {
  const url = raw ? parse(raw) : null;
  return url ? (CONNECTOR_PAGE.exec(url.pathname)?.[1] ?? null) : null;
}

export function openSheet(raw: string, connectorId: string | null = null): BrowserSheet | null {
  const url = parse(raw);
  if (!url) return null;
  return {
    url: url.href,
    host: url.host,
    secure: url.protocol === "https:",
    connectorId,
    connectorName: null,
    phase: "open",
    reason: null,
  };
}

export function connectorPath(connectorId: string): string {
  return `/v1/connectors/${encodeURIComponent(connectorId)}`;
}

export function namedSheet(
  sheet: BrowserSheet | null,
  connectorId: string,
  json: unknown,
): BrowserSheet | null {
  if (!sheet || sheet.connectorId !== connectorId) return sheet;
  const name = json && typeof json === "object" ? (json as Record<string, unknown>).name : null;
  return typeof name === "string" && name.trim() ? { ...sheet, connectorName: name.trim() } : sheet;
}

export function sheetSubject(sheet: Pick<BrowserSheet, "connectorName" | "host">): string {
  return sheet.connectorName ?? sheet.host;
}

export function sheetAddress(sheet: Pick<BrowserSheet, "url">): string {
  const url = parse(sheet.url);
  return url ? `${url.host}${url.pathname === "/" ? "" : url.pathname}` : "";
}

export interface SignInFinished {
  connectorId: string;
  outcome: "succeeded" | "failed";
  reason: string | null;
}

export function signInFinished(eventName: string, data: string): SignInFinished | null {
  if (eventName !== SIGNIN_FINISHED_EVENT) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { connector_id, outcome, reason } = payload as Record<string, unknown>;
  if (typeof connector_id !== "string" || !connector_id) return null;
  if (outcome !== "succeeded" && outcome !== "failed") return null;
  const code = typeof reason === "string" && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null;
  return { connectorId: connector_id, outcome, reason: outcome === "failed" ? code : null };
}

export type SheetEvent = { type: "finished"; event: SignInFinished } | { type: "close" };

export function reduceSheet(sheet: BrowserSheet | null, event: SheetEvent): BrowserSheet | null {
  if (!sheet || event.type === "close") return null;
  if (sheet.phase !== "open") return sheet;
  const { connectorId, outcome, reason } = event.event;
  if (sheet.connectorId !== null && sheet.connectorId !== connectorId) return sheet;
  return { ...sheet, phase: outcome, reason };
}

export const SHEET_CLOSE_MS: Record<Exclude<SheetPhase, "open">, number> = {
  succeeded: 1500,
  failed: 4000,
};
