// Deterministic Google API Discovery parser. Discovery documents are JSON
// descriptions used by Google APIs; they are not OpenAPI documents.

import type { EndpointSpec, HttpMethod } from "../document-analysis.ts";

export type GoogleDiscoveryObject = Record<string, unknown>;

export interface GoogleDiscoveryAuthHint {
  type: "query" | "oauth2";
  query_param?: string;
}

export interface ParsedGoogleDiscovery {
  endpoints: EndpointSpec[];
  base_url: string;
  auth_hint: GoogleDiscoveryAuthHint | null;
  title: string;
  version: string;
}

export interface GoogleDiscoveryMethodEntry {
  id: string;
  resource_path: string;
  method: GoogleDiscoveryObject;
}

function isObject(value: unknown): value is GoogleDiscoveryObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): GoogleDiscoveryObject {
  return isObject(value) ? value : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function parseGoogleDiscoveryDocument(content: string): GoogleDiscoveryObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Failed to parse Google Discovery document as JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("Google Discovery document root must be an object");
  }
  if (parsed.kind !== "discovery#restDescription" || parsed.protocol !== "rest") {
    throw new Error("Document is not a Google REST Discovery description");
  }
  return parsed;
}

export function googleDiscoveryBaseUrl(doc: GoogleDiscoveryObject): string {
  const declared = nonEmptyString(doc.baseUrl);
  if (declared) return declared.replace(/\/$/, "");

  const root = nonEmptyString(doc.rootUrl);
  if (!root) return "";
  const servicePath = nonEmptyString(doc.servicePath) ?? "";
  try {
    return new URL(servicePath, root).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function collectMethodsFromResource(
  resource: GoogleDiscoveryObject,
  resourcePath: string,
  out: GoogleDiscoveryMethodEntry[],
): void {
  for (const [name, value] of Object.entries(asObject(resource.methods))) {
    if (!isObject(value)) continue;
    out.push({
      id: nonEmptyString(value.id) ?? [...resourcePath.split("."), name].filter(Boolean).join("."),
      resource_path: resourcePath,
      method: value,
    });
  }

  for (const [name, value] of Object.entries(asObject(resource.resources))) {
    if (!isObject(value)) continue;
    collectMethodsFromResource(value, [resourcePath, name].filter(Boolean).join("."), out);
  }
}

export function listGoogleDiscoveryMethods(
  doc: GoogleDiscoveryObject,
): GoogleDiscoveryMethodEntry[] {
  const out: GoogleDiscoveryMethodEntry[] = [];
  collectMethodsFromResource(doc, "", out);
  return out;
}

function normalizePath(method: GoogleDiscoveryObject): string | null {
  const raw = nonEmptyString(method.flatPath) ?? nonEmptyString(method.path);
  if (!raw) return null;
  const normalized = raw.replace(/\{\+([^{}]+)\}/g, "{$1}");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function parameterSchema(parameter: GoogleDiscoveryObject): GoogleDiscoveryObject {
  const type = nonEmptyString(parameter.type) ?? "string";
  const base: GoogleDiscoveryObject = { type };
  if (typeof parameter.description === "string") base.description = parameter.description;
  if (typeof parameter.format === "string") base.format = parameter.format;
  if (Array.isArray(parameter.enum)) base.enum = parameter.enum;
  if (parameter.default !== undefined) base.default = parameter.default;
  if (parameter.repeated === true) return { type: "array", items: base };
  return base;
}

function querySchema(
  doc: GoogleDiscoveryObject,
  method: GoogleDiscoveryObject,
): GoogleDiscoveryObject | undefined {
  const parameters = {
    ...asObject(doc.parameters),
    ...asObject(method.parameters),
  };
  const query = Object.entries(parameters).filter(
    (entry): entry is [string, GoogleDiscoveryObject] =>
      isObject(entry[1]) && entry[1].location === "query",
  );
  if (query.length === 0) return undefined;

  const required = query
    .filter(([, parameter]) => parameter.required === true)
    .map(([name]) => name);
  return {
    type: "object",
    properties: Object.fromEntries(
      query.map(([name, parameter]) => [name, parameterSchema(parameter)]),
    ),
    ...(required.length > 0 ? { required } : {}),
  };
}

function resolveSchema(
  value: unknown,
  schemas: GoogleDiscoveryObject,
): GoogleDiscoveryObject | undefined {
  if (!isObject(value)) return undefined;
  const ref = nonEmptyString(value.$ref);
  if (!ref) return value;
  const resolved = schemas[ref];
  return isObject(resolved) ? resolved : value;
}

function extractAuthHint(doc: GoogleDiscoveryObject): GoogleDiscoveryAuthHint | null {
  const auth = asObject(doc.auth);
  const oauth2 = asObject(auth.oauth2);
  if (Object.keys(asObject(oauth2.scopes)).length > 0) return { type: "oauth2" };

  const apiKey = asObject(asObject(doc.parameters).key);
  if (apiKey.location === "query") return { type: "query", query_param: "key" };
  return null;
}

function extractEndpoints(doc: GoogleDiscoveryObject): EndpointSpec[] {
  const schemas = asObject(doc.schemas);
  const idempotentMethods = new Set(["GET", "PUT", "DELETE", "HEAD", "OPTIONS"]);
  const endpoints: EndpointSpec[] = [];

  for (const entry of listGoogleDiscoveryMethods(doc)) {
    const path = normalizePath(entry.method);
    const rawMethod = nonEmptyString(entry.method.httpMethod)?.toUpperCase();
    if (!path || !rawMethod) continue;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(rawMethod)) {
      continue;
    }

    const requestSchema = resolveSchema(entry.method.request, schemas);
    const responseSchema = resolveSchema(entry.method.response, schemas);
    const query = querySchema(doc, entry.method);
    const description = nonEmptyString(entry.method.description) ?? entry.id;
    endpoints.push({
      path,
      method: rawMethod as HttpMethod,
      description,
      ...(requestSchema ? { request_schema: requestSchema } : {}),
      ...(query ? { query_schema: query } : {}),
      ...(responseSchema ? { response_schema: responseSchema } : {}),
      expected_statuses: [200],
      idempotent: idempotentMethods.has(rawMethod),
    });
  }

  return endpoints;
}

export function parseGoogleDiscoveryWithMetadata(content: string): ParsedGoogleDiscovery {
  const doc = parseGoogleDiscoveryDocument(content);
  return {
    endpoints: extractEndpoints(doc),
    base_url: googleDiscoveryBaseUrl(doc),
    auth_hint: extractAuthHint(doc),
    title: nonEmptyString(doc.title) ?? nonEmptyString(doc.name) ?? "Google API",
    version: nonEmptyString(doc.version) ?? "unknown",
  };
}

export function parseGoogleDiscovery(content: string): EndpointSpec[] {
  return parseGoogleDiscoveryWithMetadata(content).endpoints;
}
