import { looksLikeGraphQLUrl } from "@shared/index.ts";
import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from "graphql";
import { log } from "../../logging/index.ts";
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
  type DiscoveryWarning,
} from "./types.ts";

export { looksLikeGraphQLUrl };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 3;
const MAX_SCHEMA_NODES = 3_000;
const MAX_TOTAL_SCHEMA_NODES = 200_000;
const MAX_ENDPOINTS = 1_000;
const MAX_SDL_SOURCE_BYTES = 4 * 1024 * 1024;
const EXPANSION_BATCH_SIZE = 25;
const DEFS_POINTER = "#/$defs/";

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

function formatTypeRef(t: TypeRef | null | undefined): string | null {
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

interface TypeDefinition {
  schema: Record<string, unknown>;
  nodes: number;
  refs: string[];
}

interface ExpansionBudget {
  remaining: number;
}

interface ExpansionContext {
  typesByName: Map<string, NamedType>;
  definitions: Map<string, TypeDefinition>;
  collisions: Set<string>;
  truncatedFields: Set<string>;
}

const isExpandable = (named: NamedType | undefined): boolean =>
  named?.kind === "INPUT_OBJECT" || named?.kind === "OBJECT" || named?.kind === "INTERFACE";

function countSchemaNodes(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + countSchemaNodes(item), 0);
  if (value !== null && typeof value === "object") {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countSchemaNodes(item), 0);
  }
  return 1;
}

function typeToJsonSchema(
  t: TypeRef | null | undefined,
  typesByName: Map<string, NamedType>,
  refs: Set<string>,
): unknown {
  if (!t) return null;
  if (t.kind === "NON_NULL") return typeToJsonSchema(t.ofType ?? null, typesByName, refs);
  if (t.kind === "LIST") {
    return { type: "array", items: typeToJsonSchema(t.ofType ?? null, typesByName, refs) };
  }
  const leaf = t.name;
  if (!leaf) return null;
  const named = typesByName.get(leaf);
  if (named?.kind === "UNION") {
    return { oneOf: (named.possibleTypes ?? []).map((p) => ({ type: p.name ?? "object" })) };
  }
  if (!isExpandable(named)) return { type: leaf };
  refs.add(leaf);
  return { $ref: `${DEFS_POINTER}${leaf}` };
}

function definitionFor(name: string, ctx: ExpansionContext): TypeDefinition | null {
  const cached = ctx.definitions.get(name);
  if (cached) return cached;
  const named = ctx.typesByName.get(name);
  if (!named || !isExpandable(named)) return null;
  const refs = new Set<string>();
  const isInput = named.kind === "INPUT_OBJECT";
  const members = isInput ? (named.inputFields ?? []) : (named.fields ?? []);
  const properties = Object.fromEntries(
    members.map((member) => [member.name, typeToJsonSchema(member.type, ctx.typesByName, refs)]),
  );
  const required = isInput ? members.filter((f) => isRequired(f.type)).map((f) => f.name) : [];
  const schema = { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  const definition = { schema, nodes: countSchemaNodes(schema), refs: [...refs] };
  ctx.definitions.set(name, definition);
  return definition;
}

function collectDefinitions(
  rootRefs: Iterable<string>,
  ctx: ExpansionContext,
  budget: ExpansionBudget,
): { defs: Record<string, unknown>; truncated: boolean } {
  const defs: Record<string, unknown> = {};
  const visited = new Set<string>();
  const queue: [string, number][] = [...rootRefs].map((name) => [name, 0]);
  let truncated = false;
  for (let index = 0; index < queue.length; index += 1) {
    const [name, distance] = queue[index] as [string, number];
    if (visited.has(name)) continue;
    visited.add(name);
    const definition = definitionFor(name, ctx);
    if (!definition) continue;
    if (distance >= MAX_SCHEMA_DEPTH || definition.nodes > budget.remaining) {
      truncated = true;
      continue;
    }
    budget.remaining -= definition.nodes;
    defs[name] = definition.schema;
    for (const ref of definition.refs) {
      if (!visited.has(ref)) queue.push([ref, distance + 1]);
    }
  }
  return { defs, truncated };
}

function withDefinitions(
  schema: Record<string, unknown>,
  rootRefs: Set<string>,
  ctx: ExpansionContext,
  budget: ExpansionBudget,
): { schema: Record<string, unknown>; truncated: boolean } {
  if (rootRefs.size === 0) return { schema, truncated: false };
  const { defs, truncated } = collectDefinitions(rootRefs, ctx, budget);
  return {
    schema: Object.keys(defs).length > 0 ? { ...schema, $defs: defs } : schema,
    truncated,
  };
}

function fieldToEndpoint(
  field: Field,
  rootKind: "query" | "mutation" | "subscription",
  ctx: ExpansionContext,
  budget: ExpansionBudget,
): DiscoveredEndpoint {
  const requestRefs = new Set<string>();
  const responseRefs = new Set<string>();
  const params: DiscoveredEndpointParam[] = field.args.map((arg) => ({
    name: arg.name,
    in: "body" as const,
    required: isRequired(arg.type),
    type: formatTypeRef(arg.type),
  }));
  const variableProps = Object.fromEntries(
    field.args.map((arg) => [arg.name, typeToJsonSchema(arg.type, ctx.typesByName, requestRefs)]),
  );
  const variableRequired = field.args.filter((arg) => isRequired(arg.type)).map((arg) => arg.name);
  const request = withDefinitions(
    {
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
    },
    requestRefs,
    ctx,
    budget,
  );
  const response = withDefinitions(
    {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            [field.name]: typeToJsonSchema(field.type, ctx.typesByName, responseRefs),
          },
        },
        errors: {
          type: "array",
          items: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    responseRefs,
    ctx,
    budget,
  );
  if (request.truncated || response.truncated) ctx.truncatedFields.add(field.name);
  const operationId = ctx.collisions.has(field.name) ? `${rootKind}.${field.name}` : field.name;
  return {
    method: "POST",
    path: "/graphql",
    summary: field.description ?? field.name,
    description: field.description ?? null,
    operation_id: operationId,
    scopes: [],
    params,
    request_body_schema: request.schema,
    request_content_type: "application/json",
    response_schemas: { "200": response.schema },
    pagination_hint: null,
    deprecated: field.isDeprecated ?? false,
  };
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DiscoveryError("aborted", "discovery aborted");
}

interface RootField {
  field: Field;
  rootKind: "query" | "mutation" | "subscription";
}

interface BoundedExpansion {
  endpoints: DiscoveredEndpoint[];
  schemaNodes: number;
}

async function expandRootFields(
  rootFields: RootField[],
  ctx: ExpansionContext,
  signal: AbortSignal | undefined,
): Promise<BoundedExpansion> {
  const global: ExpansionBudget = { remaining: MAX_TOTAL_SCHEMA_NODES };
  const endpoints: DiscoveredEndpoint[] = [];
  let schemaNodes = 0;
  for (const [index, { field, rootKind }] of rootFields.entries()) {
    if (index > 0 && index % EXPANSION_BATCH_SIZE === 0) {
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
    const share = Math.floor(Math.max(global.remaining, 0) / (rootFields.length - index));
    const budget: ExpansionBudget = { remaining: Math.min(MAX_SCHEMA_NODES, share) };
    const endpoint = fieldToEndpoint(field, rootKind, ctx, budget);
    const nodes =
      countSchemaNodes(endpoint.request_body_schema) +
      countSchemaNodes(endpoint.response_schemas["200"]);
    global.remaining -= nodes;
    schemaNodes += nodes;
    endpoints.push(endpoint);
  }
  return { endpoints, schemaNodes };
}

interface IntrospectionFetchResult {
  schema: IntrospectionSchema;
  rawData: IntrospectionQuery;
  bytes: number;
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
      bytes: buf.byteLength,
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
      throwIfAborted(opts.signal);
      const { schema, rawData, bytes } = await postIntrospection(url, opts);
      throwIfAborted(opts.signal);
      const startedAt = performance.now();
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

      const allRootFields: RootField[] = [
        ...(queryType?.fields ?? []).map((field) => ({ field, rootKind: "query" as const })),
        ...(mutationType?.fields ?? []).map((field) => ({ field, rootKind: "mutation" as const })),
        ...(subscriptionType?.fields ?? []).map((field) => ({
          field,
          rootKind: "subscription" as const,
        })),
      ];
      const rootFields = allRootFields.slice(0, MAX_ENDPOINTS);
      const ctx: ExpansionContext = {
        typesByName,
        definitions: new Map(),
        collisions,
        truncatedFields: new Set(),
      };
      const { endpoints, schemaNodes } = await expandRootFields(rootFields, ctx, opts.signal);
      const warnings: DiscoveryWarning[] = [];
      if (allRootFields.length > rootFields.length) {
        warnings.push({
          code: "endpoints_truncated",
          message: `kept ${rootFields.length} of ${allRootFields.length} root fields`,
        });
      }
      if (ctx.truncatedFields.size > 0) {
        warnings.push({
          code: "schema_truncated",
          message: `${ctx.truncatedFields.size} endpoint schemas reference types without inlined definitions`,
        });
        log.warn({
          module: "connector",
          action: "discovery.graphql.schema_truncated",
          strategy: this.name,
          url: scrubUrl(url),
          truncated_endpoints: ctx.truncatedFields.size,
          max_depth: MAX_SCHEMA_DEPTH,
          max_nodes: MAX_SCHEMA_NODES,
          max_total_nodes: MAX_TOTAL_SCHEMA_NODES,
        });
      }
      log.info({
        module: "connector",
        action: "discovery.graphql.expansion_bounded",
        strategy: this.name,
        url: scrubUrl(url),
        endpoints: endpoints.length,
        root_fields: allRootFields.length,
        definitions: ctx.definitions.size,
        schema_nodes: schemaNodes,
        bytes,
        duration_ms: Math.round(performance.now() - startedAt),
      });

      await yieldToEventLoop();
      throwIfAborted(opts.signal);
      const sdl = bytes <= MAX_SDL_SOURCE_BYTES ? tryPrintSDL(rawData) : null;
      if (bytes > MAX_SDL_SOURCE_BYTES) {
        warnings.push({
          code: "sdl_skipped",
          message: `introspection result of ${bytes} bytes exceeds ${MAX_SDL_SOURCE_BYTES} bytes for SDL rendering`,
        });
      }

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
        warnings,
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
