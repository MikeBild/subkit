import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from "graphql";
import { log } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { HttpRequestInvalidError, readBodyBytesCapped } from "../drivers/response-body.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import {
  type DiscoveredEndpoint,
  type DiscoveredEndpointParam,
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 3;
const MAX_SCHEMA_NODES = 1_500;

interface TypeRef {
  kind: string;
  name?: string | null;
  ofType?: TypeRef | null;
}

interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
  defaultValue?: string | null;
}

interface Field {
  name: string;
  description?: string | null;
  args: InputValue[];
  type: TypeRef;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

interface NamedType {
  kind: string;
  name?: string | null;
  description?: string | null;
  fields?: Field[] | null;
  inputFields?: InputValue[] | null;
  enumValues?: { name: string; description?: string | null }[] | null;
  interfaces?: TypeRef[] | null;
  possibleTypes?: TypeRef[] | null;
}

interface IntrospectionSchema {
  queryType?: { name: string } | null;
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types: NamedType[];
  directives?: { name: string; locations?: string[] }[];
}

const INTROSPECTION_DISABLED_PATTERNS = [
  /introspection/i,
  /not allowed/i,
  /disabled/i,
  /forbidden/i,
];

function isIntrospectionDisabled(message: string): boolean {
  return INTROSPECTION_DISABLED_PATTERNS.some((re) => re.test(message));
}

export function formatTypeRef(t: TypeRef | null | undefined): string | null {
  if (!t) return null;
  if (t.kind === "NON_NULL" && t.ofType) {
    const inner = formatTypeRef(t.ofType);
    return inner ? `${inner}!` : null;
  }
  if (t.kind === "LIST" && t.ofType) {
    const inner = formatTypeRef(t.ofType);
    return inner ? `[${inner}]` : null;
  }
  return t.name ?? null;
}

function isRequired(t: TypeRef): boolean {
  return t.kind === "NON_NULL";
}

interface ExpansionBudget {
  remaining: number;
  truncated: boolean;
}

const newBudget = (): ExpansionBudget => ({ remaining: MAX_SCHEMA_NODES, truncated: false });

function typeToJsonSchema(
  t: TypeRef | null | undefined,
  typesByName: Map<string, NamedType>,
  seen: Set<string>,
  budget: ExpansionBudget,
  depth = 0,
): unknown {
  if (!t) return null;
  if (t.kind === "NON_NULL") {
    return typeToJsonSchema(t.ofType ?? null, typesByName, seen, budget, depth);
  }
  if (t.kind === "LIST") {
    return {
      type: "array",
      items: typeToJsonSchema(t.ofType ?? null, typesByName, seen, budget, depth),
    };
  }
  const leaf = t.name;
  if (!leaf) return null;
  if (seen.has(leaf)) return { $ref: leaf };
  const named = typesByName.get(leaf);
  if (!named) return { type: leaf };
  if (named.kind === "SCALAR" || named.kind === "ENUM") {
    return { type: leaf };
  }
  if (named.kind === "UNION") {
    return {
      oneOf: (named.possibleTypes ?? []).map((p) => ({ type: p.name ?? "object" })),
    };
  }
  if (named.kind !== "INPUT_OBJECT" && named.kind !== "OBJECT" && named.kind !== "INTERFACE") {
    return { type: leaf };
  }
  if (depth >= MAX_SCHEMA_DEPTH || budget.remaining <= 0) {
    budget.truncated = true;
    return { $ref: leaf };
  }
  seen.add(leaf);
  const members = named.kind === "INPUT_OBJECT" ? (named.inputFields ?? []) : (named.fields ?? []);
  const properties: Record<string, unknown> = {};
  for (const member of members) {
    budget.remaining -= 1;
    properties[member.name] = typeToJsonSchema(member.type, typesByName, seen, budget, depth + 1);
  }
  seen.delete(leaf);
  if (named.kind !== "INPUT_OBJECT") return { type: "object", properties };
  const required = (named.inputFields ?? []).filter((f) => isRequired(f.type)).map((f) => f.name);
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

function fieldToEndpoint(
  field: Field,
  rootKind: "query" | "mutation" | "subscription",
  typesByName: Map<string, NamedType>,
  collisions: Set<string>,
  truncatedFields: Set<string>,
): DiscoveredEndpoint {
  const expand = (type: TypeRef): unknown => {
    const budget = newBudget();
    const schema = typeToJsonSchema(type, typesByName, new Set(), budget);
    if (budget.truncated) truncatedFields.add(field.name);
    return schema;
  };
  const params: DiscoveredEndpointParam[] = field.args.map((arg) => ({
    name: arg.name,
    in: "body" as const,
    required: isRequired(arg.type),
    type: formatTypeRef(arg.type),
  }));
  const variableProps: Record<string, unknown> = {};
  const variableRequired: string[] = [];
  for (const arg of field.args) {
    variableProps[arg.name] = expand(arg.type);
    if (isRequired(arg.type)) variableRequired.push(arg.name);
  }
  const requestBodySchema = {
    type: "object",
    properties: {
      query: { type: "string" },
      operationName: { type: "string" },
      variables: {
        type: "object",
        properties: variableProps,
        ...(variableRequired.length > 0 ? { required: variableRequired } : {}),
      },
    },
    required: ["query"],
  };
  const responseSchema = {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          [field.name]: expand(field.type),
        },
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    },
  };
  const operationId = collisions.has(field.name) ? `${rootKind}.${field.name}` : field.name;
  return {
    method: "POST",
    path: "/graphql",
    summary: field.description ?? field.name,
    description: field.description ?? null,
    operation_id: operationId,
    scopes: [],
    params,
    request_body_schema: requestBodySchema,
    request_content_type: "application/json",
    response_schemas: { "200": responseSchema },
    pagination_hint: null,
    deprecated: field.isDeprecated ?? false,
  };
}

export function looksLikeGraphQLUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (path === "/graphql") return true;
    if (/^\/graphql\/v\d+$/.test(path)) return true;
    if (/\/graphql$/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

interface IntrospectionFetchResult {
  schema: IntrospectionSchema;
  rawData: IntrospectionQuery;
}

async function postIntrospection(
  url: string,
  opts: DiscoveryStrategyOptions,
): Promise<IntrospectionFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...(opts.headers ?? {}),
    };
    const body = JSON.stringify({
      query: getIntrospectionQuery(),
      operationName: "IntrospectionQuery",
    });
    assertEgressAllowed(url, {});
    const res = await getDriverFetch()(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new DiscoveryError(
          "auth_required",
          `POST ${scrubUrl(url)} returned ${res.status} — credentials required for introspection`,
        );
      }
      throw new DiscoveryError(
        `http_${res.status}`,
        `POST ${scrubUrl(url)} returned ${res.status}`,
      );
    }
    const buf = await readBodyBytesCapped(
      res,
      MAX_SIZE_BYTES,
      scrubUrl(url),
      controller.signal,
    ).catch((err: unknown) => {
      if (err instanceof HttpRequestInvalidError) {
        throw new DiscoveryError(
          "spec_too_large",
          `introspection result at ${scrubUrl(url)} exceeds ${MAX_SIZE_BYTES} bytes`,
        );
      }
      throw err;
    });
    const text = new TextDecoder().decode(buf);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DiscoveryError("parse_failed", `JSON parse failed: ${msg}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new DiscoveryError(
        "parse_failed",
        `introspection response at ${scrubUrl(url)} is not an object`,
      );
    }
    const obj = parsed as { errors?: { message?: string }[]; data?: { __schema?: unknown } };
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const message = obj.errors.map((e) => e?.message ?? "").join("; ");
      if (isIntrospectionDisabled(message)) {
        throw new DiscoveryError(
          "introspection_disabled",
          `introspection refused by ${scrubUrl(url)}: ${message}`,
        );
      }
      throw new DiscoveryError(
        "introspection_errors",
        `introspection returned errors at ${scrubUrl(url)}: ${message}`,
      );
    }
    const schema = obj.data?.__schema;
    if (!schema || typeof schema !== "object") {
      throw new DiscoveryError(
        "parse_failed",
        `introspection response at ${scrubUrl(url)} missing data.__schema`,
      );
    }
    return {
      schema: schema as IntrospectionSchema,
      rawData: obj.data as unknown as IntrospectionQuery,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tryPrintSDL(introspection: IntrospectionQuery): string | null {
  try {
    const built = buildClientSchema(introspection);
    return printSchema(built);
  } catch (err) {
    log.warn({
      module: "connector",
      action: "discovery.graphql.sdl_render_failed",
      msg: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

class GraphQLIntrospectStrategy implements DiscoveryStrategy {
  readonly name = "graphql-introspect" as const;

  canHandle(url: string): boolean {
    return looksLikeGraphQLUrl(url);
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });
    try {
      const { schema, rawData } = await postIntrospection(url, opts);
      const typesByName = new Map<string, NamedType>();
      for (const t of schema.types ?? []) {
        if (t?.name) typesByName.set(t.name, t);
      }

      const queryName = schema.queryType?.name ?? null;
      const mutationName = schema.mutationType?.name ?? null;
      const subscriptionName = schema.subscriptionType?.name ?? null;

      const allFieldNames = new Set<string>();
      const collisions = new Set<string>();
      const trackCollisions = (fields: Field[] | null | undefined): void => {
        for (const f of fields ?? []) {
          if (allFieldNames.has(f.name)) collisions.add(f.name);
          allFieldNames.add(f.name);
        }
      };
      const queryType = queryName ? typesByName.get(queryName) : null;
      const mutationType = mutationName ? typesByName.get(mutationName) : null;
      const subscriptionType = subscriptionName ? typesByName.get(subscriptionName) : null;
      trackCollisions(queryType?.fields);
      trackCollisions(mutationType?.fields);
      trackCollisions(subscriptionType?.fields);

      const truncatedFields = new Set<string>();
      const endpoints: DiscoveredEndpoint[] = [
        ...(queryType?.fields ?? []).map((f) =>
          fieldToEndpoint(f, "query", typesByName, collisions, truncatedFields),
        ),
        ...(mutationType?.fields ?? []).map((f) =>
          fieldToEndpoint(f, "mutation", typesByName, collisions, truncatedFields),
        ),
        ...(subscriptionType?.fields ?? []).map((f) =>
          fieldToEndpoint(f, "subscription", typesByName, collisions, truncatedFields),
        ),
      ];
      if (truncatedFields.size > 0) {
        log.warn({
          module: "connector",
          action: "discovery.graphql.schema_truncated",
          strategy: this.name,
          url: scrubUrl(url),
          truncated_endpoints: truncatedFields.size,
          max_depth: MAX_SCHEMA_DEPTH,
          max_nodes: MAX_SCHEMA_NODES,
        });
      }

      const sdl = tryPrintSDL(rawData);

      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        endpoints: endpoints.length,
        query_type: queryName,
        mutation_type: mutationName,
        subscription_type: subscriptionName,
        sdl_bytes: sdl?.length ?? 0,
      });

      return {
        source_url: url,
        fetched_at: new Date().toISOString(),
        strategy: this.name,
        spec_version: null,
        title: queryName ?? "GraphQL API",
        servers: [url],
        auth_schemes: [],
        endpoints,
        warnings: [],
        text_corpus: sdl,
      };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "fetch_failed";
      const message = err instanceof Error ? err.message : String(err);
      log.debug({
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

export const graphqlIntrospectStrategy: DiscoveryStrategy = new GraphQLIntrospectStrategy();
