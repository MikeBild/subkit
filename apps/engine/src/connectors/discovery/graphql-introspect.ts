// Strategy: GraphQL `__schema` introspection.
//
// For the growing class of GraphQL-native APIs (GitHub GraphQL, Linear,
// Monday, Shopify Admin) that don't ship OpenAPI specs but DO expose
// introspection. We POST `getIntrospectionQuery()` from the canonical
// `graphql` package, normalise each query / mutation / subscription root
// field into a `DiscoveredEndpoint`, and return the same shape every other
// strategy produces — so downstream consumers (`knowledge_sources` rows,
// the LLM prompt builder, the auto-pagination heuristic) need no special
// case for GraphQL.
//
// The endpoint path is the introspection target itself (a GraphQL service
// answers every operation at one URL). `method` is always POST, `params`
// becomes the field's `args` flattened with `in: "body"`, and the
// `request_body_schema` is a synthesised JSON-shaped object describing
// the expected `{ query, variables }` payload.

import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from "graphql";
import { log } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
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

/**
 * Resolve a `TypeRef` to a printable GraphQL type signature
 * (e.g. `[String!]!`). Mirrors what the GraphQL spec calls "type
 * formatting". Used for `params[].type` and as the leaf identifier for
 * downstream callers that want a stable text key.
 */
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

/** True when the outermost wrapper is `NON_NULL`. */
function isRequired(t: TypeRef): boolean {
  return t.kind === "NON_NULL";
}

/**
 * Build a JSON-shape representation of a GraphQL type, recursing into
 * object / input-object types. Includes a small cycle-breaker so
 * recursive schemas (e.g. GitHub `Repository -> Owner -> Repository`)
 * don't blow the stack.
 */
function typeToJsonSchema(
  t: TypeRef | null | undefined,
  typesByName: Map<string, NamedType>,
  seen: Set<string>,
): unknown {
  if (!t) return null;
  if (t.kind === "NON_NULL") {
    return typeToJsonSchema(t.ofType ?? null, typesByName, seen);
  }
  if (t.kind === "LIST") {
    return { type: "array", items: typeToJsonSchema(t.ofType ?? null, typesByName, seen) };
  }
  const leaf = t.name;
  if (!leaf) return null;
  if (seen.has(leaf)) return { $ref: leaf };
  const named = typesByName.get(leaf);
  if (!named) return { type: leaf };
  if (named.kind === "SCALAR" || named.kind === "ENUM") {
    return { type: leaf };
  }
  if (named.kind === "INPUT_OBJECT") {
    seen.add(leaf);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of named.inputFields ?? []) {
      properties[f.name] = typeToJsonSchema(f.type, typesByName, seen);
      if (isRequired(f.type)) required.push(f.name);
    }
    seen.delete(leaf);
    return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  }
  if (named.kind === "OBJECT" || named.kind === "INTERFACE") {
    seen.add(leaf);
    const properties: Record<string, unknown> = {};
    for (const f of named.fields ?? []) {
      properties[f.name] = typeToJsonSchema(f.type, typesByName, seen);
    }
    seen.delete(leaf);
    return { type: "object", properties };
  }
  if (named.kind === "UNION") {
    return {
      oneOf: (named.possibleTypes ?? []).map((p) => ({ type: p.name ?? "object" })),
    };
  }
  return { type: leaf };
}

/**
 * Normalise a single root-level field into a `DiscoveredEndpoint`.
 * `rootKind` is "query" | "mutation" | "subscription" — only used to
 * stamp a stable `operation_id` prefix when the field name collides
 * across roots (rare but possible for e.g. `note` query + `note`
 * mutation).
 */
function fieldToEndpoint(
  field: Field,
  rootKind: "query" | "mutation" | "subscription",
  typesByName: Map<string, NamedType>,
  collisions: Set<string>,
): DiscoveredEndpoint {
  const params: DiscoveredEndpointParam[] = field.args.map((arg) => ({
    name: arg.name,
    in: "body" as const,
    required: isRequired(arg.type),
    type: formatTypeRef(arg.type),
  }));
  // request_body_schema models the GraphQL request envelope: the agent
  // sends `{ query, variables: { ...args } }`. We describe `variables`
  // explicitly so prompt assembly can show argument shapes.
  const variableProps: Record<string, unknown> = {};
  const variableRequired: string[] = [];
  for (const arg of field.args) {
    variableProps[arg.name] = typeToJsonSchema(arg.type, typesByName, new Set());
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
  // 200 schema: GraphQL always responds with `{ data: { <fieldName>: <T> } }`.
  const responseSchema = {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          [field.name]: typeToJsonSchema(field.type, typesByName, new Set()),
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
    response_schemas: { "200": responseSchema },
    pagination_hint: null,
    deprecated: field.isDeprecated ?? false,
  };
}

/**
 * `true` when the URL pathname looks like a GraphQL endpoint
 * (`/graphql`, optional version suffix). Hostnames like
 * `api.github.com/graphql` and `api.linear.app/graphql` match.
 */
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
  /** The full `data` envelope returned by the upstream — used to feed
   *  `buildClientSchema` so we can emit SDL alongside the normalised
   *  endpoints. Pre-fix only the truncated schema view (root fields)
   *  was reachable, blocking deep-nested query authoring. */
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
      throw new DiscoveryError(
        `http_${res.status}`,
        `POST ${scrubUrl(url)} returned ${res.status}`,
      );
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_SIZE_BYTES) {
      throw new DiscoveryError(
        "spec_too_large",
        `introspection result at ${scrubUrl(url)} exceeds ${MAX_SIZE_BYTES} bytes`,
      );
    }
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

/** Render an introspection result as SDL. Returns null on failure (we
 *  emit the normalised endpoints in any case). Failures are typically
 *  caused by partial/malformed introspection responses; not worth
 *  failing the whole discovery for. */
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

      const endpoints: DiscoveredEndpoint[] = [];
      for (const f of queryType?.fields ?? []) {
        endpoints.push(fieldToEndpoint(f, "query", typesByName, collisions));
      }
      for (const f of mutationType?.fields ?? []) {
        endpoints.push(fieldToEndpoint(f, "mutation", typesByName, collisions));
      }
      for (const f of subscriptionType?.fields ?? []) {
        endpoints.push(fieldToEndpoint(f, "subscription", typesByName, collisions));
      }

      // Render the full schema as SDL so the LLM can see deep nested
      // types when authoring queries. The normalised `endpoints` array
      // only describes the top-level field args — without SDL the LLM
      // has no way to know that e.g. `Issue.comments` exists or its
      // shape, blocking nested-query authoring against APIs like
      // GitHub / Linear / Monday.
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
