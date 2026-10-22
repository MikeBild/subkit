import { getConfig, isConfigLoaded } from "../../config/loader.ts";
import type { ConnectionAuthorityIdentity } from "../../credentials/authority-metadata.ts";
import type { CredentialUseSnapshot } from "../../credentials/index.ts";
import { refreshIfStale } from "../../credentials/oauth2/refresh-worker.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import { parseSignedJwtConfig, signJwtBearer } from "../../credentials/signed-jwt.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db, Executor } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { fetchWithEgressGuard } from "../egress-fetch.ts";
import { assertEgressAllowedResolved, assertRobotsAllowed } from "../egress-guard.ts";
import { requestUsedStoredCredential } from "../reauth.ts";
import { connectorHeaderPolicy, requestHeaderViolations } from "../request-header-policy.ts";
import { scraperUserAgent } from "../scraper-user-agent.ts";
import { getConnectorProbeEndpoint } from "../template-binding.ts";
import { type ProbeEndpoint, ProbeEndpointSchema } from "../templates.ts";
import type { ConnectorView } from "../types.ts";
import { settleOnAbort } from "./abort-boundary.ts";
import { signSigV4Request } from "./aws-sigv4.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import { shouldPromoteToFile } from "./file-promotion.ts";
import { buildProbeDiagnostics } from "./probe-diagnostics.ts";
import { resolveUrl } from "./resolve-url.ts";
import { HttpRequestInvalidError, readBodyBytesCapped } from "./response-body.ts";

export { EgressBlockedError } from "../egress-guard.ts";
export { HttpRequestInvalidError, readBodyBytesCapped, readBodyCapped } from "./response-body.ts";

export const FETCH_DEADLINE_MS = 60_000;

export const DEFAULT_MAX_RESPONSE_BYTES = 104_857_600;

export function resolveMaxResponseBytes(tenant_id?: string): number {
  return isConfigLoaded()
    ? getConfig(tenant_id).connectors.http.max_response_bytes
    : DEFAULT_MAX_RESPONSE_BYTES;
}

export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function validateOutboundHeaders(headers: unknown): void {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new HttpRequestInvalidError(
      `headers must be a {string: string} record, got ${Array.isArray(headers) ? "array" : typeof headers}`,
      "headers",
    );
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      throw new HttpRequestInvalidError(
        `header name "${name}" is not an RFC 7230 token — fix the workflow's headers field`,
        `headers.${name}`,
      );
    }
    if (typeof value !== "string") {
      throw new HttpRequestInvalidError(
        `header "${name}" must be a string, got ${typeof value}`,
        `headers.${name}`,
      );
    }
  }
}

export interface HttpRequestDescriptor {
  base_url: string | null;
  path_or_url: string;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
}

export function applyAuthMaterial(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean>,
): void {
  const cfg = (connector.config ?? {}) as {
    static_headers?: Record<string, string>;
    static_query?: Record<string, string>;
  };
  if (cfg.static_headers) {
    for (const [k, v] of Object.entries(cfg.static_headers)) {
      headers[k] = v;
    }
  }
  if (cfg.static_query) {
    for (const [k, v] of Object.entries(cfg.static_query)) {
      query[k] = v;
    }
  }
  if (!credential) {
    return;
  }
  switch (credential.mode) {
    case "none":
      return;
    case "header":
      for (const [k, v] of Object.entries(credential.headers)) {
        headers[k] = v;
      }
      return;
    case "query":
      for (const [k, v] of Object.entries(credential.query)) {
        query[k] = v;
      }
      return;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${encoded}`;
      return;
    }
    case "aws_sigv4":
      return;
    case "oauth2": {
      if (!credential.access_token) return;
      const scheme = (credential.token_type ?? "").trim();
      if (scheme === "" || /^(none|no_prefix)$/i.test(scheme)) {
        headers.Authorization = credential.access_token;
      } else if (scheme.toLowerCase() === "bearer") {
        headers.Authorization = `Bearer ${credential.access_token}`;
      } else {
        headers.Authorization = `${scheme} ${credential.access_token}`;
      }
      return;
    }
    case "token_mint": {
      if (!credential.access_token) return;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: header_template is operator-supplied and ${token} is a literal placeholder, not a JS template
      const tpl = credential.header_template ?? "Bearer ${token}";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal placeholder above
      headers.Authorization = tpl.replaceAll("${token}", credential.access_token);
      return;
    }
    case "oauth2_client":
      throw new Error(
        "oauth2_client credentials are not directly applied to HTTP requests — they identify the registered OAuth2 client and are consumed by the token endpoint flow.",
      );
    case "oauth2_private_key":
      throw new Error(
        "oauth2_private_key credentials are not directly applied to HTTP requests — they are consumed by the MCP client pool's PrivateKeyJwtProvider.",
      );
    case "signed_jwt":
      return;
  }
  const _exhaustive: never = credential;
  void _exhaustive;
}

export interface ResolveConnectorRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
  redact_log_url?: (url: string) => string;
}

export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed"
  | "aws_sigv4"
  | "token_mint_static"
  | "token_mint_refreshed"
  | "signed_jwt";

export interface ResolvedConnectorCredential {
  credential_snapshot?: CredentialUseSnapshot;
  credential: DecryptedCredential | null;
  credential_id: string | null;
  credential_revision: number | null;
  connection_authority?: ConnectionAuthorityIdentity | null;
  oauth2_refreshed: boolean;
}

export interface RequestDispatchPolicy {
  redirect: "manual";
}

export interface HttpDispatchObservation {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  unsupported_body?: boolean;
}

export class AuthorityDispatchError extends Error {
  readonly code = "authority_invalid";
  constructor() {
    super("The redirect target requires separate authorization; no redirect was followed.");
    this.name = "AuthorityDispatchError";
  }
}

export async function checkAuthorityRedirect(
  response: Response,
  policy: RequestDispatchPolicy | undefined,
): Promise<void> {
  if (
    policy &&
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.has("location")
  ) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new AuthorityDispatchError();
  }
}

export async function resolveConnectorCredential(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  override?: DecryptedCredential | null;
}): Promise<ResolvedConnectorCredential> {
  if (p.override !== undefined) {
    return {
      credential: p.override,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  if (p.connector.auth_type === "none") {
    return {
      credential: null,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  const row = await getCredentialForConnector(
    p.tenant_id,
    p.connector.id,
    p.connector.environment,
    p.db,
  );
  if (!row) {
    return {
      credential: null,
      credential_id: null,
      credential_revision: null,
      oauth2_refreshed: false,
    };
  }
  let credential: DecryptedCredential = row.value;
  let oauth2_refreshed = false;
  if (credential.mode === "oauth2") {
    const preToken = credential.access_token;
    credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
    if (credential.mode === "oauth2" && credential.access_token !== preToken) {
      oauth2_refreshed = true;
    }
  }
  return {
    credential,
    credential_id: row.row.id,
    credential_revision: row.row.authority_revision,
    credential_snapshot: row.credential_snapshot ?? {
      connector_id: p.connector.id,
      environment: p.connector.environment,
      credential_id: row.row.id,
      credential_generation: row.row.credential_generation,
      connection_id: null,
      access_token_version: null,
      identity: row.row.verified_identity,
    },
    connection_authority: row.connection_authority ?? null,
    oauth2_refreshed,
  };
}

export function deriveAppliedAuthMethod(
  credential: DecryptedCredential | null,
  oauth2Refreshed: boolean,
): AppliedAuthMethod {
  if (!credential) return "none";
  switch (credential.mode) {
    case "none":
      return "none";
    case "bearer":
      return "bearer";
    case "header":
      return "header";
    case "query":
      return "query";
    case "basic":
      return "basic";
    case "oauth2":
      return oauth2Refreshed ? "oauth2_refreshed" : "oauth2_static";
    case "aws_sigv4":
      return "aws_sigv4";
    case "token_mint":
      return oauth2Refreshed ? "token_mint_refreshed" : "token_mint_static";
    case "oauth2_client":
      return "none";
    case "oauth2_private_key":
      return "none";
    case "signed_jwt":
      return "signed_jwt";
  }
}

export async function applySignedJwtAuth(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  url: URL,
  headers: Record<string, string>,
): Promise<string | null> {
  if (credential?.mode !== "signed_jwt") return null;
  const base = connector.base_url ? new URL(connector.base_url) : null;
  if (!base || base.origin !== url.origin) {
    throw Object.assign(new Error("signed_jwt requests must stay on the connector origin"), {
      code: "signed_jwt_origin_invalid",
    });
  }
  const token = await signJwtBearer({
    private_key: credential.private_key,
    config: parseSignedJwtConfig(connector.config ?? {}),
  });
  headers.Authorization = `Bearer ${token}`;
  return token;
}

export function redactSignedJwtValue(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.replaceAll(token, "[REDACTED]");
  if (Buffer.isBuffer(value)) {
    const source = Buffer.from(token, "utf8");
    const out = Buffer.from(value);
    let index = out.indexOf(source);
    while (index >= 0) {
      out.fill(0x2a, index, index + source.length);
      index = out.indexOf(source, index + source.length);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSignedJwtValue(entry, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replaceAll(token, "[REDACTED]"),
        redactSignedJwtValue(entry, token),
      ]),
    );
  }
  return value;
}

function redactSignedJwtResponse(
  result: HttpExecutionResult,
  token: string | null,
): HttpExecutionResult {
  if (!token) return result;
  return {
    ...result,
    headers: redactSignedJwtValue(result.headers, token) as Record<string, string>,
    body: redactSignedJwtValue(result.body, token),
    ...(result.body_raw
      ? { body_raw: redactSignedJwtValue(result.body_raw, token) as Buffer }
      : {}),
  };
}

export interface ResolvedRequestPlan {
  credential_snapshot?: CredentialUseSnapshot;
  credential_revision: number | null;
  connection_authority: ResolvedConnectorCredential["connection_authority"];
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  credential_id: string | null;
  auth_method: AppliedAuthMethod;
  stored_credential_used: boolean;
}

export async function buildRequestPlan(
  p: ResolveConnectorRequestParams,
): Promise<ResolvedRequestPlan> {
  const headers = { ...(p.headers ?? {}) };
  const query = { ...(p.query ?? {}) };
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const {
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    credential_snapshot,
    oauth2_refreshed: oauth2Refreshed,
  } = await resolveConnectorCredential(resolveOpts);
  const violations = requestHeaderViolations(
    headers,
    connectorHeaderPolicy(p.connector, credential),
  );
  if (violations.length > 0)
    throw new HttpRequestInvalidError(
      "request headers conflict with connector authentication",
      "headers",
    );
  applyAuthMaterial(p.connector, credential, headers, query);
  if (p.idempotency_key) {
    headers["Idempotency-Key"] = p.idempotency_key;
  }
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  const callerQuery = {
    ...Object.fromEntries(url.searchParams),
    ...(p.query ?? {}),
  };
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const plan: ResolvedRequestPlan = {
    url,
    headers,
    query,
    credential,
    credential_id: credentialId,
    credential_revision: credentialRevision,
    connection_authority: connectionAuthority,
    ...(credential_snapshot ? { credential_snapshot } : {}),
    auth_method: deriveAppliedAuthMethod(credential, oauth2Refreshed),
    stored_credential_used:
      p.credential_override === undefined &&
      requestUsedStoredCredential({
        credential,
        home: p.connector.base_url,
        url,
        caller_headers: p.headers,
        caller_query: callerQuery,
      }),
  };
  await assertEgressAllowedResolved(url, { tenant_id: p.tenant_id, exec: p.db });
  const snapshot = (p.connector.template_snapshot as { respects_robots?: unknown } | null) ?? null;
  if (snapshot?.respects_robots === true) {
    const cfg = getConfig(p.tenant_id).connectors.web_scraper.runtime;
    const respectRobots =
      typeof p.connector.config.respect_robots === "boolean"
        ? p.connector.config.respect_robots
        : cfg.respect_robots;
    if (respectRobots) {
      const userAgent = scraperUserAgent(p.tenant_id, p.connector.config.user_agent);
      headers["User-Agent"] = userAgent;
      await assertRobotsAllowed(url, { tenant_id: p.tenant_id, exec: p.db, userAgent });
    }
  }
  log.connector.request.planned({
    connector_id: p.connector.id,
    auth_type: p.connector.auth_type,
    url_host: url.host,
    url: p.redact_log_url ? p.redact_log_url(scrubUrl(url)) : scrubUrl(url),
    has_credential: credential !== null,
    oauth2_refreshed: oauth2Refreshed,
  });
  return plan;
}

export interface HttpExecutionResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  url: string;
  body_raw?: Buffer;
}

export interface ConnectorHttpResult extends HttpExecutionResult {
  stored_credential_used: boolean;
}

function shouldSniff(contentType: string): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.includes("application/octet-stream")) return true;
  if (ct === "text/plain" || ct.startsWith("text/plain;")) return true;
  return false;
}

function sniffBodyShape(text: string): "json" | "xml" | "csv" | null {
  const sample = text.slice(0, 512).trimStart();
  if (!sample) return null;
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (sample.startsWith("<?xml") || /^<[a-z_][\w:.-]*[\s>]/i.test(sample)) return "xml";
  const lines = sample.split(/\r?\n/);
  if (lines.length >= 2) {
    const header = lines[0] ?? "";
    if (header.includes(",")) {
      const cells = header.split(",");
      const looksLikeIdentifierHeader =
        cells.length >= 2 && cells.every((c) => /^[A-Za-z_][\w\-.]{0,63}$/.test(c.trim()));
      const secondLineHasContent = (lines[1] ?? "").trim().length > 0;
      if (looksLikeIdentifierHeader && secondLineHasContent) return "csv";
    }
  }
  return null;
}

function isJsonContentType(contentType: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("application/json") ||
    ct.includes("application/x-amz-json") ||
    ct.includes("application/vnd.api+json") ||
    ct.includes("application/ld+json") ||
    ct.includes("application/hal+json") ||
    /\+json(\b|;)/.test(ct)
  );
}

export function parseResponseBody(text: string, contentType: string): unknown {
  if (isJsonContentType(contentType) && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (shouldSniff(contentType) && text.length > 0) {
    const shape = sniffBodyShape(text);
    if (shape === "json") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (shape === "csv") {
      return parseCsvBody(text);
    }
    if (shape === "xml") {
      const parsed = parseXmlBody(text);
      if (parsed !== null) return parsed;
    }
  }
  return text;
}

export { serializeXmlBody } from "../../utils/xml-parser.ts";

import { parseXmlBody } from "../../utils/xml-parser.ts";

function parseCsvBody(text: string): Array<Record<string, string>> {
  try {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cur.push(field);
          field = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          cur.push(field);
          rows.push(cur);
          cur = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || cur.length > 0) {
      cur.push(field);
      rows.push(cur);
    }
    if (rows.length === 0) return [];
    const header = rows[0]!;
    return rows.slice(1).map((cells) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i]!] = cells[i] ?? "";
      }
      return obj;
    });
  } catch {
    return [];
  }
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

export interface ResolvedFilePart {
  name: string;
  file?: {
    openRead(): Promise<AsyncIterable<Uint8Array>>;
    filename: string;
    content_type: string | null;
    size_bytes: number;
  };
  value?: string;
  filename?: string;
  content_type?: string;
}

export async function buildMultipartBody(parts: ResolvedFilePart[]): Promise<FormData> {
  const form = new FormData();
  for (const part of parts) {
    if (part.file !== undefined) {
      const f = part.file;
      const effectiveFilename = part.filename ?? f.filename;
      const effectiveContentType =
        part.content_type ?? f.content_type ?? "application/octet-stream";
      let blob: Blob;
      {
        const chunks: ArrayBuffer[] = [];
        for await (const raw of await f.openRead()) {
          const ab = raw.buffer.slice(
            raw.byteOffset,
            raw.byteOffset + raw.byteLength,
          ) as ArrayBuffer;
          chunks.push(ab);
        }
        blob = new Blob(chunks, { type: effectiveContentType });
      }
      form.append(part.name, blob, effectiveFilename);
    } else if (part.value !== undefined) {
      form.append(part.name, part.value);
    }
  }
  return form;
}

export async function executePlannedHttpRequest(params: {
  exec?: Executor;
  before_dispatch?: (
    request: HttpDispatchObservation,
  ) => Promise<RequestDispatchPolicy | undefined>;
  tenant_id: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  multipartBody?: FormData;
  signal: AbortSignal;
  sigv4?: {
    region: string;
    service: string;
    credential: import("../../credentials/types.ts").AwsSigV4CredentialValue;
  };
  signed_jwt?: {
    connector: ConnectorView;
    credential: Extract<DecryptedCredential, { mode: "signed_jwt" }>;
  };
  capture_binary?: boolean;
}): Promise<HttpExecutionResult> {
  validateOutboundHeaders(params.headers);

  const headers = { ...params.headers };
  const init: RequestInit = {
    method: params.method,
    headers,
    signal: params.signal,
  };
  if (params.multipartBody !== undefined && params.method !== "GET" && params.method !== "HEAD") {
    delete headers["content-type"];
    delete headers["Content-Type"];
    init.body = params.multipartBody;
  } else if (
    params.body !== undefined &&
    params.body !== null &&
    params.method !== "GET" &&
    params.method !== "HEAD"
  ) {
    init.body = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }
  injectTraceContext(headers);
  if (params.sigv4) {
    signSigV4Request({
      method: params.method,
      url: params.url,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      region: params.sigv4.region,
      service: params.sigv4.service,
      credential: params.sigv4.credential,
    });
  }
  const dispatchPolicy = await params.before_dispatch?.({
    method: params.method,
    url: params.url.toString(),
    headers: params.headers,
    body: params.body ?? null,
    ...(params.multipartBody ? { unsupported_body: true } : {}),
  });
  const effectiveDispatchPolicy =
    dispatchPolicy ??
    (params.signed_jwt ? ({ redirect: "manual" } satisfies RequestDispatchPolicy) : undefined);
  if (effectiveDispatchPolicy) init.redirect = effectiveDispatchPolicy.redirect;
  let signedJwtToken: string | null = null;
  if (params.signed_jwt) {
    await assertEgressAllowedResolved(params.url, {
      tenant_id: params.tenant_id,
      ...(params.exec ? { exec: params.exec } : {}),
    });
    signedJwtToken = await applySignedJwtAuth(
      params.signed_jwt.connector,
      params.signed_jwt.credential,
      params.url,
      headers,
    );
  }
  const res = await instrument({
    module: "connector",
    action: "driver.http.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { method: params.method, url_host: params.url.host },
    fn: () =>
      settleOnAbort(
        fetchWithEgressGuard(
          params.url,
          init,
          { tenant_id: params.tenant_id, ...(params.exec ? { exec: params.exec } : {}) },
          {
            fetchImpl: getDriverFetch(),
          },
        ),
        params.signal,
      ),
  });
  const maxResponseBytes = resolveMaxResponseBytes(params.tenant_id);
  await checkAuthorityRedirect(res, effectiveDispatchPolicy);
  const buf = await readBodyBytesCapped(
    res,
    maxResponseBytes,
    params.url.toString(),
    params.signal,
  );
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (
    params.capture_binary &&
    res.status >= 200 &&
    res.status < 300 &&
    shouldPromoteToFile({
      status: res.status,
      content_type: contentType,
      content_disposition: res.headers.get("content-disposition"),
      bytes: buf,
    })
  ) {
    return redactSignedJwtResponse(
      {
        status: res.status,
        headers: headerObj,
        body: undefined,
        body_raw: buf,
        bytes_in: buf.byteLength,
        url: params.url.toString(),
      },
      signedJwtToken,
    );
  }
  const text = buf.toString("utf8");
  return redactSignedJwtResponse(
    {
      status: res.status,
      headers: headerObj,
      body: parseResponseBody(text, contentType),
      bytes_in: buf.byteLength,
      url: params.url.toString(),
    },
    signedJwtToken,
  );
}

export async function executeConnectorHttpRequest(params: {
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
    >,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: string;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal?: AbortSignal;
  timeout_ms?: number;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
}): Promise<ConnectorHttpResult> {
  const planArgs: ResolveConnectorRequestParams = {
    db: params.db,
    tenant_id: params.tenant_id,
    connector: params.connector,
    path_or_url: params.path_or_url,
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.query ? { query: params.query } : {}),
    ...(params.credential_override ? { credential_override: params.credential_override } : {}),
    ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
  };
  const plan = await buildRequestPlan(planArgs);
  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  let timeoutSignal: AbortSignal | null = null;
  if (params.timeout_ms !== undefined) {
    timeoutSignal = AbortSignal.timeout(params.timeout_ms);
    signals.push(timeoutSignal);
  }
  const signal =
    signals.length === 0
      ? AbortSignal.timeout(FETCH_DEADLINE_MS)
      : signals.length === 1
        ? signals[0]!
        : mergeSignals(signals);

  let sigv4Args: Parameters<typeof executePlannedHttpRequest>[0]["sigv4"] | undefined;
  if (plan.credential?.mode === "aws_sigv4") {
    const cfg = (params.connector.config ?? {}) as {
      aws_region?: unknown;
      aws_service?: unknown;
    };
    const region = typeof cfg.aws_region === "string" ? cfg.aws_region : "us-east-1";
    const service = typeof cfg.aws_service === "string" ? cfg.aws_service : null;
    if (!service) {
      throw new Error(
        `aws_sigv4 connector ${params.connector.id} missing required config.aws_service`,
      );
    }
    sigv4Args = { region, service, credential: plan.credential };
  }

  const beforeDispatch = params.before_dispatch;
  const signedJwt = plan.credential?.mode === "signed_jwt";
  const result = await executePlannedHttpRequest({
    exec: params.db,
    tenant_id: params.tenant_id,
    method: params.method,
    url: plan.url,
    headers: plan.headers,
    body: params.body,
    signal,
    ...(sigv4Args ? { sigv4: sigv4Args } : {}),
    ...(plan.credential?.mode === "signed_jwt"
      ? { signed_jwt: { connector: params.connector, credential: plan.credential } }
      : {}),
    ...(beforeDispatch || signedJwt
      ? {
          before_dispatch: async () => {
            const policy = beforeDispatch
              ? await beforeDispatch({
                  ...(plan.credential_snapshot
                    ? { credential_snapshot: plan.credential_snapshot }
                    : {}),
                  credential_id: plan.credential_id,
                  credential_revision: plan.credential_revision,
                  connection_authority: plan.connection_authority ?? null,
                })
              : undefined;
            return signedJwt ? { redirect: "manual" } : policy;
          },
        }
      : {}),
  });
  return { ...result, stored_credential_used: plan.stored_credential_used };
}

export interface HttpProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  warning_only: boolean;
  warnings: Array<{ code: string; message: string }>;
  error_code?:
    | "credential_missing"
    | "credential_invalid"
    | "credential_expired"
    | "credential_unverified"
    | "scope_insufficient"
    | "remote_api_disabled"
    | "remote_resource_not_found"
    | "unknown_upstream_error";
  provider_action_url?: string;
  body_snippet?: string;
  response_headers?: Record<string, string>;
}

function detectAccessNotConfiguredBody(body: unknown): {
  matched: boolean;
  api_name?: string;
} {
  if (!body || typeof body !== "object") return { matched: false };
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return { matched: false };
  const errors = (err as { errors?: unknown }).errors;
  const reasonMatches = (val: unknown): boolean =>
    typeof val === "object" &&
    val !== null &&
    (val as { reason?: unknown }).reason === "accessNotConfigured";
  if (Array.isArray(errors) && errors.some(reasonMatches)) {
    const message = (err as { message?: unknown }).message;
    const apiNameMatch =
      typeof message === "string" ? /\b([A-Z][A-Za-z]*?)\s+API\b/.exec(message) : null;
    const api_name = apiNameMatch?.[1];
    return api_name !== undefined ? { matched: true, api_name } : { matched: true };
  }
  return { matched: false };
}

function googleEnableApiDeepLink(connector: ConnectorView, api_name?: string): string | undefined {
  const baseUrl =
    typeof connector.base_url === "string" && connector.base_url.length > 0
      ? connector.base_url
      : null;
  let service: string | undefined;
  if (api_name) {
    service = `${api_name.toLowerCase()}.googleapis.com`;
  } else if (baseUrl && /googleapis\.com/.test(baseUrl)) {
    const hostMatch = /https?:\/\/([a-z0-9-]+\.googleapis\.com)/i.exec(baseUrl);
    service = hostMatch?.[1];
  }
  if (!service) return undefined;
  return `https://console.cloud.google.com/apis/library/${service}`;
}

export function classifyHttpProbeStatus(
  status: number,
  connector: ConnectorView,
  body?: unknown,
): { code: HttpProbeResult["error_code"]; provider_action_url?: string } {
  if ((status === 403 || status === 404 || status === 400) && body !== undefined) {
    const ancBody = detectAccessNotConfiguredBody(body);
    if (ancBody.matched) {
      const deepLink = googleEnableApiDeepLink(connector, ancBody.api_name);
      return {
        code: "remote_api_disabled",
        ...(deepLink ? { provider_action_url: deepLink } : {}),
      };
    }
  }
  if (status === 401) return { code: "credential_invalid" };
  if (status === 403) return { code: "scope_insufficient" };
  if (status === 404) return { code: "remote_resource_not_found" };
  if (status >= 500) return { code: "unknown_upstream_error" };
  if (status >= 400) return { code: "unknown_upstream_error" };
  return { code: "unknown_upstream_error" };
}

export function resolveProbeEndpointConfig(connector: ConnectorView): ProbeEndpoint | null {
  const raw = getConnectorProbeEndpoint(connector);
  if (raw === null || raw === undefined) return null;
  const parsed = ProbeEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpRequestInvalidError(
      `invalid connector probe_endpoint: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "config.probe_endpoint",
    );
  }
  const config = parsed.data;
  const templateRaw = getConnectorProbeEndpoint({
    ...connector,
    config: {},
  });
  const template = ProbeEndpointSchema.safeParse(templateRaw);
  if (
    !template.success ||
    template.data.method !== config.method ||
    template.data.path !== config.path ||
    !template.data.headers
  )
    return config;
  const headers = { ...template.data.headers };
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    const inherited = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (inherited) delete headers[inherited];
    headers[name] = value;
  }
  return { ...config, headers };
}

function assertProbeHeadersDoNotShadowCredential(
  config: ProbeEndpoint | null,
  credential: DecryptedCredential | null,
): void {
  if (!config?.headers || credential?.mode !== "header") return;
  const credentialNames = new Set(
    Object.keys(credential.headers).map((name) => name.toLowerCase()),
  );
  const shadowed = Object.keys(config.headers).find((name) =>
    credentialNames.has(name.toLowerCase()),
  );
  if (shadowed) {
    throw new HttpRequestInvalidError(
      `probe header "${shadowed}" is supplied by the saved credential`,
      `config.probe_endpoint.headers.${shadowed}`,
    );
  }
}

export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  credential_override?: DecryptedCredential | null;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return {
        ok: false,
        latency_ms: 0,
        detail: "connector has no base_url",
        warning_only: false,
        warnings: [],
      };
    }

    let probeCredential: DecryptedCredential | null = null;
    if (p.connector.auth_type !== "none") {
      const credRow =
        p.credential_override !== undefined
          ? p.credential_override && { value: p.credential_override }
          : await getCredentialForConnector(
              p.tenant_id,
              p.connector.id,
              p.connector.environment,
              p.db,
            );
      if (!credRow) {
        return {
          ok: false,
          latency_ms: 0,
          detail:
            "credential_required: probe requires a saved credential — collect one via ask_user_form and persist via save_connector_draft({credential})",
          warning_only: false,
          warnings: [
            {
              code: "CREDENTIAL_REQUIRED",
              message: "draft has no attached credential; cannot probe",
            },
          ],
          error_code: "credential_missing",
        };
      }
      probeCredential = credRow.value;
    }

    const probeConfig = resolveProbeEndpointConfig(p.connector);
    assertProbeHeadersDoNotShadowCredential(probeConfig, probeCredential);

    const method = probeConfig?.method ?? "GET";
    const pathOrUrl = probeConfig !== null && probeConfig.path !== "" ? probeConfig.path : "/";

    const res = await executeConnectorHttpRequest({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method,
      path_or_url: pathOrUrl,
      ...(probeConfig?.headers ? { headers: probeConfig.headers } : {}),
      ...(p.credential_override !== undefined
        ? { credential_override: p.credential_override }
        : {}),
    });

    const latency_ms = Date.now() - start;
    const warnings: Array<{ code: string; message: string }> = [];
    let ok: boolean;
    let warning_only = false;
    let unverifiedFallback = false;

    if (probeConfig !== null) {
      const [lo, hi] = probeConfig.expected_status ?? [200, 299];
      ok = res.status >= lo && res.status <= hi;
    } else {
      if (res.status === 404 || res.status === 405) {
        ok = true;
        warning_only = true;
        warnings.push({
          code: "PROBE_AMBIGUOUS",
          message: `Fallback probe GET / returned ${res.status}; connectivity likely OK but endpoint unknown.`,
        });
      } else if (res.status === 401 || res.status === 403) {
        ok = false;
        unverifiedFallback = probeCredential !== null;
      } else {
        ok = res.status < 500;
      }
    }

    const result: HttpProbeResult = { ok, latency_ms, status: res.status, warning_only, warnings };
    if (!ok) {
      const classification = classifyHttpProbeStatus(res.status, p.connector, res.body);
      if (unverifiedFallback && classification.code !== "remote_api_disabled") {
        result.error_code = "credential_unverified";
        result.warning_only = true;
        warnings.push({
          code: "PROBE_AUTH_UNVERIFIED",
          message: `Fallback probe GET / returned ${res.status}: the root path requires sign-in, so the credential was not verified. Set config.probe_endpoint to a cheap authenticated read.`,
        });
      } else if (classification.code) {
        result.error_code = classification.code;
      }
      if (classification.provider_action_url) {
        result.provider_action_url = classification.provider_action_url;
      }
      Object.assign(result, buildProbeDiagnostics(res.headers, res.body));
    }
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms,
      status: res.status,
    });
    return result;
  } catch (err) {
    const result: HttpProbeResult = {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      warning_only: false,
      warnings: [],
    };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms: result.latency_ms,
      detail: result.detail,
    });
    return result;
  }
}
