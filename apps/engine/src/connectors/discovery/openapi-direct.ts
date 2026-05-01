// Strategy #1: fetch a URL we already believe is an OpenAPI / Swagger spec
// and normalise it into a `DiscoveryResult`.
//
// Supports both OpenAPI 3.x and Swagger 2.x. YAML is detected by file
// extension or `content-type`; JSON otherwise. Pagination heuristics run
// per-operation against parameter names first, then a sample 200 response
// schema, then the `Link` header.

import { load as loadYaml } from "js-yaml";
import { log } from "../../logging/logger.ts";
import { scrubUrl } from "../egress.ts";
import {
  type DiscoveredAuthScheme,
  type DiscoveredEndpoint,
  type DiscoveredEndpointPaginationHint,
  type DiscoveredEndpointParam,
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
  type HttpMethod,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 16 * 1024 * 1024; // discovery specs can be larger than runtime fetches

/**
 * Rewrite well-known doc-hosting URLs to their raw-spec equivalents so the
 * fetcher gets JSON/YAML instead of a Swagger-UI HTML shell. Returns the
 * original URL when no rule matches. Idempotent — already-rewritten URLs
 * pass through unchanged.
 *
 * Currently handles:
 *   - SwaggerHub UI host (`app.swaggerhub.com/apis/`) → API host
 *     (`api.swaggerhub.com/apis/`), same `/{owner}/{api}/{version}` path.
 *   - SwaggerHub *rendered docs* host (`app.swaggerhub.com/apis-docs/`) →
 *     API host (`api.swaggerhub.com/apis/`). Operators frequently paste
 *     the docs URL when the API URL is what they want.
 *   The API host returns JSON by default; the UI / docs hosts return
 *   rendered HTML pages that would trip `unknown_spec_version`.
 */
export function normalizeKnownHosts(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.hostname === "app.swaggerhub.com") {
    if (url.pathname.startsWith("/apis/")) {
      url.hostname = "api.swaggerhub.com";
      return url.toString();
    }
    if (url.pathname.startsWith("/apis-docs/")) {
      url.hostname = "api.swaggerhub.com";
      url.pathname = url.pathname.replace("/apis-docs/", "/apis/");
      return url.toString();
    }
  }
  return rawUrl;
}

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const PAGINATION_PARAM_NAMES: Record<string, "page" | "cursor" | "offset"> = {
  page: "page",
  pagenumber: "page",
  page_number: "page",
  per_page: "page",
  perpage: "page",
  pagesize: "page",
  page_size: "page",
  limit: "offset",
  offset: "offset",
  start: "offset",
  starting_after: "cursor",
  ending_before: "cursor",
  cursor: "cursor",
  next: "cursor",
  next_token: "cursor",
  next_cursor: "cursor",
  pagetoken: "cursor",
  page_token: "cursor",
};

interface LooseObject {
  [key: string]: unknown;
}

function isObject(v: unknown): v is LooseObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asRecord(v: unknown): LooseObject {
  return isObject(v) ? v : {};
}

function looksYaml(url: string, contentType: string | null): boolean {
  const lower = url.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("yaml") || ct.includes("yml")) return true;
  }
  return false;
}

function parseSpecText(text: string, url: string, contentType: string | null): LooseObject {
  if (looksYaml(url, contentType)) {
    try {
      const parsed = loadYaml(text);
      if (!isObject(parsed)) {
        throw new DiscoveryError("parse_failed", `YAML root is not an object at ${url}`);
      }
      return parsed;
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new DiscoveryError("parse_failed", `YAML parse failed: ${msg}`);
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isObject(parsed)) {
      throw new DiscoveryError("parse_failed", `JSON root is not an object at ${url}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    // Fall back to YAML parse if the JSON parse failed (some endpoints
    // serve YAML with a generic `text/plain` content-type).
    try {
      const parsed = loadYaml(text);
      if (isObject(parsed)) return parsed;
    } catch {
      // ignore — original error wins
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new DiscoveryError("parse_failed", `JSON parse failed: ${msg}`);
  }
}

async function fetchSpec(
  url: string,
  opts: DiscoveryStrategyOptions,
): Promise<{ text: string; contentType: string | null; linkHeader: string | null }> {
  const effectiveUrl = normalizeKnownHosts(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  // If the caller supplied a signal, abort our internal controller when
  // theirs fires so we honour both budgets.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const headers: Record<string, string> = {
      accept: "application/json, application/yaml, text/yaml, */*",
      ...(opts.headers ?? {}),
    };
    const res = await fetch(effectiveUrl, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      throw new DiscoveryError(`http_${res.status}`, `GET ${scrubUrl(url)} returned ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_SIZE_BYTES) {
      throw new DiscoveryError(
        "spec_too_large",
        `spec at ${scrubUrl(url)} exceeds ${MAX_SIZE_BYTES} bytes`,
      );
    }
    const text = new TextDecoder().decode(buf);
    return {
      text,
      contentType: res.headers.get("content-type"),
      linkHeader: res.headers.get("link"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function detectSpecVersion(spec: LooseObject): "openapi-3" | "swagger-2" | null {
  if (typeof spec.openapi === "string" && spec.openapi.startsWith("3.")) return "openapi-3";
  if (typeof spec.swagger === "string" && spec.swagger.startsWith("2.")) return "swagger-2";
  return null;
}

function extractTitle(spec: LooseObject): string | null {
  const info = asRecord(spec.info);
  return asString(info.title);
}

function extractServers(spec: LooseObject): string[] {
  // OpenAPI 3.x
  if (Array.isArray(spec.servers)) {
    const out: string[] = [];
    for (const srv of spec.servers) {
      if (isObject(srv) && typeof srv.url === "string") out.push(srv.url);
    }
    if (out.length > 0) return out;
  }
  // Swagger 2.x — assemble from host + basePath + schemes
  const host = asString(spec.host);
  if (host) {
    const basePath = asString(spec.basePath) ?? "";
    const schemes = asStringArray(spec.schemes);
    const scheme = schemes.includes("https") ? "https" : (schemes[0] ?? "https");
    return [`${scheme}://${host}${basePath}`];
  }
  return [];
}

function extractAuthSchemesV3(spec: LooseObject): DiscoveredAuthScheme[] {
  const components = asRecord(spec.components);
  const schemes = asRecord(components.securitySchemes);
  const out: DiscoveredAuthScheme[] = [];
  for (const [name, raw] of Object.entries(schemes)) {
    if (!isObject(raw)) continue;
    const type = asString(raw.type);
    if (type !== "apiKey" && type !== "http" && type !== "oauth2" && type !== "openIdConnect") {
      continue;
    }
    const scheme: DiscoveredAuthScheme = { name, type };
    const inLoc = asString(raw.in);
    if (inLoc === "header" || inLoc === "query" || inLoc === "cookie") scheme.location = inLoc;
    const httpScheme = asString(raw.scheme);
    if (httpScheme) scheme.scheme = httpScheme;
    if (type === "oauth2") {
      const flows = asRecord(raw.flows);
      const flowsOut: NonNullable<DiscoveredAuthScheme["flows"]> = {};
      for (const [flowName, flowRaw] of Object.entries(flows)) {
        if (!isObject(flowRaw)) continue;
        const scopesRaw = asRecord(flowRaw.scopes);
        const scopes: Record<string, string> = {};
        for (const [k, v] of Object.entries(scopesRaw)) {
          if (typeof v === "string") scopes[k] = v;
        }
        const authUrl = asString(flowRaw.authorizationUrl);
        const tokenUrl = asString(flowRaw.tokenUrl);
        flowsOut[flowName] = {
          ...(authUrl ? { authorization_url: authUrl } : {}),
          ...(tokenUrl ? { token_url: tokenUrl } : {}),
          scopes,
        };
      }
      scheme.flows = flowsOut;
    }
    out.push(scheme);
  }
  return out;
}

function extractAuthSchemesV2(spec: LooseObject): DiscoveredAuthScheme[] {
  const defs = asRecord(spec.securityDefinitions);
  const out: DiscoveredAuthScheme[] = [];
  for (const [name, raw] of Object.entries(defs)) {
    if (!isObject(raw)) continue;
    const type = asString(raw.type);
    if (type === "apiKey") {
      const inLoc = asString(raw.in);
      const entry: DiscoveredAuthScheme = { name, type: "apiKey" };
      if (inLoc === "header" || inLoc === "query" || inLoc === "cookie") {
        entry.location = inLoc;
      }
      out.push(entry);
    } else if (type === "basic") {
      out.push({ name, type: "http", scheme: "basic" });
    } else if (type === "oauth2") {
      const flowName = asString(raw.flow) ?? "implicit";
      const scopesRaw = asRecord(raw.scopes);
      const scopes: Record<string, string> = {};
      for (const [k, v] of Object.entries(scopesRaw)) {
        if (typeof v === "string") scopes[k] = v;
      }
      const authUrl = asString(raw.authorizationUrl);
      const tokenUrl = asString(raw.tokenUrl);
      out.push({
        name,
        type: "oauth2",
        flows: {
          [flowName]: {
            ...(authUrl ? { authorization_url: authUrl } : {}),
            ...(tokenUrl ? { token_url: tokenUrl } : {}),
            scopes,
          },
        },
      });
    }
  }
  return out;
}

function paramTypeFromSchema(schema: unknown): string | null {
  if (!isObject(schema)) return null;
  if (typeof schema.type === "string") return schema.type;
  if (typeof schema.$ref === "string") return schema.$ref;
  return null;
}

function extractParams(operation: LooseObject, pathItem: LooseObject): DiscoveredEndpointParam[] {
  const out: DiscoveredEndpointParam[] = [];
  const seen = new Set<string>();
  const sources: unknown[] = [];
  if (Array.isArray(pathItem.parameters)) sources.push(...pathItem.parameters);
  if (Array.isArray(operation.parameters)) sources.push(...operation.parameters);
  for (const raw of sources) {
    if (!isObject(raw)) continue;
    const name = asString(raw.name);
    const inLoc = asString(raw.in);
    if (!name || !inLoc) continue;
    if (inLoc !== "path" && inLoc !== "query" && inLoc !== "header" && inLoc !== "cookie") {
      continue;
    }
    const dedupKey = `${inLoc}:${name}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const required = raw.required === true || inLoc === "path";
    let type: string | null = null;
    if (isObject(raw.schema)) type = paramTypeFromSchema(raw.schema);
    if (!type && typeof raw.type === "string") type = raw.type;
    out.push({ name, in: inLoc, required, type });
  }
  return out;
}

function extractRequestBody(operation: LooseObject, isV2: boolean): unknown | null {
  if (isV2) {
    const params = Array.isArray(operation.parameters) ? operation.parameters : [];
    for (const p of params) {
      if (isObject(p) && p.in === "body" && isObject(p.schema)) return p.schema;
    }
    return null;
  }
  const body = asRecord(operation.requestBody);
  const content = asRecord(body.content);
  // Prefer JSON body schema; fall back to first content type.
  const json = asRecord(content["application/json"]);
  if (isObject(json.schema)) return json.schema;
  for (const value of Object.values(content)) {
    if (isObject(value) && isObject(value.schema)) return value.schema;
  }
  return null;
}

function extractResponses(operation: LooseObject, isV2: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const responses = asRecord(operation.responses);
  for (const [status, raw] of Object.entries(responses)) {
    if (!isObject(raw)) continue;
    if (isV2) {
      if (isObject(raw.schema)) out[status] = raw.schema;
      continue;
    }
    const content = asRecord(raw.content);
    const json = asRecord(content["application/json"]);
    if (isObject(json.schema)) {
      out[status] = json.schema;
      continue;
    }
    for (const value of Object.values(content)) {
      if (isObject(value) && isObject(value.schema)) {
        out[status] = value.schema;
        break;
      }
    }
  }
  return out;
}

function detectPaginationFromParams(
  params: DiscoveredEndpointParam[],
): DiscoveredEndpointPaginationHint | null {
  const matches: { kind: "page" | "cursor" | "offset"; name: string }[] = [];
  for (const p of params) {
    if (p.in !== "query") continue;
    const lower = p.name.toLowerCase();
    const kind = PAGINATION_PARAM_NAMES[lower];
    if (kind) matches.push({ kind, name: p.name });
  }
  if (matches.length === 0) return null;
  // Cursor wins over page wins over offset when mixed.
  const order: Record<"cursor" | "page" | "offset", number> = { cursor: 0, page: 1, offset: 2 };
  matches.sort((a, b) => order[a.kind] - order[b.kind]);
  const top = matches[0];
  if (!top) return null;
  const kind = top.kind;
  return {
    kind,
    param_names: matches.filter((m) => m.kind === kind).map((m) => m.name),
  };
}

function detectPaginationFromResponse(
  responses: Record<string, unknown>,
): DiscoveredEndpointPaginationHint | null {
  // DigitalOcean-style: response schema describes `links.pages.next`.
  const success = responses["200"] ?? responses["201"] ?? responses.default;
  if (!isObject(success)) return null;
  const props = asRecord(success.properties);
  const links = asRecord(props.links);
  const linksProps = asRecord(links.properties);
  if (linksProps.pages || linksProps.next) {
    return { kind: "cursor", param_names: [] };
  }
  return null;
}

function extractScopes(operation: LooseObject): string[] {
  const out = new Set<string>();
  if (!Array.isArray(operation.security)) return [];
  for (const entry of operation.security) {
    if (!isObject(entry)) continue;
    for (const value of Object.values(entry)) {
      if (Array.isArray(value)) {
        for (const s of value) if (typeof s === "string") out.add(s);
      }
    }
  }
  return [...out];
}

function buildEndpoints(
  spec: LooseObject,
  isV2: boolean,
  responseLinkHeader: string | null,
): DiscoveredEndpoint[] {
  const endpoints: DiscoveredEndpoint[] = [];
  const paths = asRecord(spec.paths);
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!isObject(pathItemRaw)) continue;
    for (const method of HTTP_METHODS) {
      const lower = method.toLowerCase();
      const opRaw = pathItemRaw[lower];
      if (!isObject(opRaw)) continue;

      const params = extractParams(opRaw, pathItemRaw);
      const responses = extractResponses(opRaw, isV2);
      let pagination: DiscoveredEndpointPaginationHint | null = detectPaginationFromParams(params);
      if (!pagination) pagination = detectPaginationFromResponse(responses);
      // If the live response carried a `Link: <…>; rel="next"` header for
      // this URL we capture that as a fallback hint.
      if (
        !pagination &&
        method === "GET" &&
        responseLinkHeader &&
        /rel\s*=\s*"?next"?/i.test(responseLinkHeader)
      ) {
        pagination = { kind: "link_header", param_names: [] };
      }

      endpoints.push({
        method,
        path,
        summary: asString(opRaw.summary),
        description: asString(opRaw.description),
        operation_id: asString(opRaw.operationId),
        scopes: extractScopes(opRaw),
        params,
        request_body_schema: extractRequestBody(opRaw, isV2),
        response_schemas: responses,
        pagination_hint: pagination,
        deprecated: opRaw.deprecated === true,
      });
    }
  }
  return endpoints;
}

/**
 * Parse a raw spec object (already JSON / YAML decoded) into a
 * `DiscoveryResult`. Exposed so other strategies (e.g.
 * `swagger-ui-scrape`) can reuse the normaliser without re-fetching.
 */
export function normalizeSpec(
  spec: LooseObject,
  sourceUrl: string,
  linkHeader: string | null = null,
): Omit<DiscoveryResult, "strategy"> {
  const version = detectSpecVersion(spec);
  if (!version) {
    throw new DiscoveryError(
      "unknown_spec_version",
      `spec at ${scrubUrl(sourceUrl)} is neither OpenAPI 3 nor Swagger 2`,
    );
  }
  const isV2 = version === "swagger-2";
  const auth = isV2 ? extractAuthSchemesV2(spec) : extractAuthSchemesV3(spec);
  const endpoints = buildEndpoints(spec, isV2, linkHeader);
  return {
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    spec_version: version,
    title: extractTitle(spec),
    servers: extractServers(spec),
    auth_schemes: auth,
    endpoints,
    warnings: [],
  };
}

class OpenApiDirectStrategy implements DiscoveryStrategy {
  readonly name = "openapi-direct" as const;

  canHandle(_url: string): boolean {
    // The orchestrator decides eligibility — we always attempt direct fetch
    // because callers already think the URL is a spec.
    return true;
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });
    try {
      const { text, contentType, linkHeader } = await fetchSpec(url, opts);
      const spec = parseSpecText(text, url, contentType);
      const normalised = normalizeSpec(spec, url, linkHeader);
      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        endpoints: normalised.endpoints.length,
        spec_version: normalised.spec_version,
      });
      return { ...normalised, strategy: this.name };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "fetch_failed";
      const message = err instanceof Error ? err.message : String(err);
      log.warn({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(url),
        code,
        message,
      });
      if (err instanceof DiscoveryError) throw err;
      throw new DiscoveryError(code, message);
    }
  }
}

export const openApiDirectStrategy: DiscoveryStrategy = new OpenApiDirectStrategy();
