// Deterministic OpenAPI 3.x parser. No LLM required.

import { load as loadYaml } from "js-yaml";

import type { EndpointSpec, HttpMethod } from "../document-analysis.ts";

type LooseObject = Record<string, unknown>;

export interface OpenApiAuthHint {
  type: "header" | "query" | "bearer" | "basic" | "oauth2";
  header_name?: string;
  query_param?: string;
}

export interface ParsedOpenApi {
  endpoints: EndpointSpec[];
  servers: string[];
  auth_hint: OpenApiAuthHint | null;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function isObject(value: unknown): value is LooseObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): LooseObject {
  return isObject(value) ? value : {};
}

function parseDocument(content: string): LooseObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = loadYaml(content);
    } catch {
      throw new Error("Failed to parse OpenAPI document as JSON or YAML");
    }
  }
  if (!isObject(parsed)) {
    throw new Error("OpenAPI document root must be an object");
  }
  return parsed;
}

function expandServerUrl(server: LooseObject): string | null {
  if (typeof server.url !== "string" || server.url.trim() === "") return null;
  const variables = asObject(server.variables);
  let unresolved = false;
  const expanded = server.url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variable = asObject(variables[name]);
    const defaultValue = variable.default;
    if (
      typeof defaultValue !== "string" &&
      typeof defaultValue !== "number" &&
      typeof defaultValue !== "boolean"
    ) {
      unresolved = true;
      return "";
    }
    return String(defaultValue);
  });
  return unresolved ? null : expanded;
}

function resolveServerUrl(server: LooseObject, sourceUrl?: string): string | null {
  const expanded = expandServerUrl(server);
  if (!expanded) return null;
  try {
    const resolved = sourceUrl ? new URL(expanded, sourceUrl) : new URL(expanded);
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
    return resolved.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function extractServers(doc: LooseObject, sourceUrl?: string): string[] {
  if (!Array.isArray(doc.servers)) return [];
  const seen = new Set<string>();
  for (const rawServer of doc.servers) {
    if (!isObject(rawServer)) continue;
    const resolved = resolveServerUrl(rawServer, sourceUrl);
    if (resolved) seen.add(resolved);
  }
  return [...seen];
}

function addSecurityRequirementNames(value: unknown, names: string[]): void {
  if (!Array.isArray(value)) return;
  for (const requirement of value) {
    if (!isObject(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      if (!names.includes(name)) names.push(name);
    }
  }
}

function referencedSecuritySchemeNames(doc: LooseObject): {
  names: string[];
  security_declared: boolean;
} {
  const names: string[] = [];
  let securityDeclared = Array.isArray(doc.security);
  addSecurityRequirementNames(doc.security, names);
  const paths = asObject(doc.paths);
  for (const pathItemValue of Object.values(paths)) {
    if (!isObject(pathItemValue)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItemValue[method];
      if (!isObject(operation)) continue;
      if (Array.isArray(operation.security)) securityDeclared = true;
      addSecurityRequirementNames(operation.security, names);
    }
  }
  return { names, security_declared: securityDeclared };
}

function authHintForScheme(scheme: LooseObject): OpenApiAuthHint | null {
  const type = typeof scheme.type === "string" ? scheme.type : "";
  if (type === "http") {
    const httpScheme = typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : "";
    if (httpScheme === "bearer") return { type: "bearer" };
    if (httpScheme === "basic") return { type: "basic" };
    return null;
  }
  if (type === "oauth2" || type === "openIdConnect") return { type: "oauth2" };
  if (type !== "apiKey" || typeof scheme.name !== "string") return null;
  if (scheme.in === "header") return { type: "header", header_name: scheme.name };
  if (scheme.in === "query") return { type: "query", query_param: scheme.name };
  return null;
}

function extractAuthHint(doc: LooseObject): OpenApiAuthHint | null {
  const components = asObject(doc.components);
  const schemes = asObject(components.securitySchemes);
  const referenced = referencedSecuritySchemeNames(doc);
  const orderedNames = referenced.security_declared ? referenced.names : Object.keys(schemes);

  const priority: Record<OpenApiAuthHint["type"], number> = {
    bearer: 0,
    oauth2: 1,
    header: 2,
    query: 3,
    basic: 4,
  };
  const candidates: Array<{ hint: OpenApiAuthHint; order: number }> = [];
  for (const [order, name] of orderedNames.entries()) {
    const rawScheme = schemes[name];
    if (!isObject(rawScheme)) continue;
    const hint = authHintForScheme(rawScheme);
    if (hint) candidates.push({ hint, order });
  }
  candidates.sort(
    (left, right) =>
      priority[left.hint.type] - priority[right.hint.type] || left.order - right.order,
  );
  return candidates[0]?.hint ?? null;
}

function extractEndpoints(doc: LooseObject): EndpointSpec[] {
  const paths = asObject(doc.paths);
  const endpoints: EndpointSpec[] = [];

  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) continue;
    for (const method of HTTP_METHODS) {
      const operationValue = pathItemValue[method];
      if (!isObject(operationValue)) continue;

      const responses = asObject(operationValue.responses);
      const expected_statuses = Object.keys(responses)
        .map(Number)
        .filter((status) => !Number.isNaN(status) && status >= 200 && status < 600);

      const requestBody = asObject(operationValue.requestBody);
      const requestContent = asObject(requestBody.content);
      const jsonContent = asObject(requestContent["application/json"]);
      const rawRequestSchema = jsonContent.schema;
      const request_schema = isObject(rawRequestSchema) ? rawRequestSchema : undefined;

      const rawParameters = Array.isArray(operationValue.parameters)
        ? operationValue.parameters
        : [];
      const queryParams = rawParameters.filter(
        (parameter): parameter is LooseObject => isObject(parameter) && parameter.in === "query",
      );
      const query_schema: Record<string, unknown> | undefined =
        queryParams.length > 0
          ? {
              type: "object",
              properties: Object.fromEntries(
                queryParams
                  .filter((parameter) => typeof parameter.name === "string")
                  .map((parameter) => [
                    parameter.name as string,
                    isObject(parameter.schema) ? parameter.schema : { type: "string" },
                  ]),
              ),
              required: queryParams
                .filter(
                  (parameter) => parameter.required === true && typeof parameter.name === "string",
                )
                .map((parameter) => parameter.name as string),
            }
          : undefined;

      const idempotentMethods = new Set(["get", "put", "head", "options", "delete"]);
      const description =
        typeof operationValue.summary === "string"
          ? operationValue.summary
          : typeof operationValue.description === "string"
            ? operationValue.description
            : undefined;
      endpoints.push({
        path,
        method: method.toUpperCase() as HttpMethod,
        ...(description !== undefined ? { description } : {}),
        ...(request_schema !== undefined ? { request_schema } : {}),
        ...(query_schema !== undefined ? { query_schema } : {}),
        expected_statuses: expected_statuses.length > 0 ? expected_statuses : [200],
        idempotent: idempotentMethods.has(method),
      });
    }
  }

  return endpoints;
}

export function parseOpenApiWithMetadata(content: string, sourceUrl?: string): ParsedOpenApi {
  const doc = parseDocument(content);
  return {
    endpoints: extractEndpoints(doc),
    servers: extractServers(doc, sourceUrl),
    auth_hint: extractAuthHint(doc),
  };
}

export function parseOpenApi(content: string): EndpointSpec[] {
  return parseOpenApiWithMetadata(content).endpoints;
}
