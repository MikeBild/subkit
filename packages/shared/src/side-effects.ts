import { Kind, parse } from "graphql";
import { looksLikeGraphQLUrl } from "./graphql-url.ts";

export type SideEffect = "read" | "write";

export type GraphqlOperation = "query" | "mutation" | "subscription";

export type McpOperation = "call_tool" | "read_resource" | "get_prompt";

export interface SideEffectInput {
  override?: SideEffect | null;
  method?: string | null;
  graphql?: { operation?: GraphqlOperation | null; query?: string | null } | null;
  sql?: { query: string; also?: ReadonlyArray<{ query: string }> } | null;
  s3?: boolean | null;
  mcp?: { operation: McpOperation } | null;
  target?: string | null;
  body?: unknown;
  baseUrl?: string | null;
}

export interface GraphqlOverHttpInput {
  method?: string | null;
  target?: string | null;
  body?: unknown;
  baseUrl?: string | null;
}

export interface GraphqlOverHttpRequest {
  endpoint: boolean;
  documents: Array<string | null>;
}

const S3_READ_METHODS = new Set(["GET", "HEAD", "LIST"]);

const RELATIVE_TARGET_ORIGIN = "https://relative-target.invalid";

const LEADING_PLACEHOLDER = /^\$\{[^}]*\}/;

const RUNTIME_PLACEHOLDER = /\$\{/;

function absoluteTarget(target: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const rest = target.replace(LEADING_PLACEHOLDER, "").replace(/^\/+/, "");
  const base = baseUrl.replace(/\/+$/, "");
  return rest ? `${base}/${rest}` : base;
}

function parsedBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPersistedQuery(entry: Record<string, unknown>): boolean {
  return isRecord(entry.extensions) && isRecord(entry.extensions.persistedQuery);
}

export function graphqlOverHttpRequest(input: GraphqlOverHttpInput): GraphqlOverHttpRequest | null {
  if ((input.method ?? "GET").toUpperCase() !== "POST") return null;
  const baseUrl = input.baseUrl?.trim() || RELATIVE_TARGET_ORIGIN;
  const endpoint = looksLikeGraphQLUrl(absoluteTarget(input.target?.trim() ?? "", baseUrl));
  const body = parsedBody(input.body);
  const entries = Array.isArray(body) ? body : [body];
  const records = entries.every(isRecord) ? entries : [];
  const documents = records.map((entry) => (typeof entry.query === "string" ? entry.query : null));
  const shaped = records.some(
    (entry) =>
      isPersistedQuery(entry) ||
      (typeof entry.query === "string" && inferGraphqlOperation(entry.query) !== null),
  );
  return endpoint || shaped ? { endpoint, documents } : null;
}

export function classifyGraphqlOverHttp(input: SideEffectInput): SideEffect | null {
  if (input.graphql || input.sql || input.mcp || input.s3) return null;
  const request = graphqlOverHttpRequest(input);
  if (request === null) return null;
  const everyDocumentIsQuery =
    request.documents.length > 0 &&
    request.documents.every(
      (document) =>
        document !== null &&
        !RUNTIME_PLACEHOLDER.test(document) &&
        inferGraphqlOperation(document) === "query",
    );
  if (!everyDocumentIsQuery) return "write";
  return request.endpoint ? "read" : null;
}

export function httpMethodIsRead(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

export function inferGraphqlOperation(query: string): GraphqlOperation | null {
  try {
    const operations = parse(query, { maxTokens: 10_000 }).definitions.filter(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    if (operations.some((operation) => operation.operation === "mutation")) return "mutation";
    if (operations.some((operation) => operation.operation === "subscription"))
      return "subscription";
    return operations.length > 0 ? "query" : null;
  } catch {
    return null;
  }
}

export function sqlIsSelect(query: string): boolean {
  let s = query;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*\n?/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) break;
    s = next;
  }
  return /^select\b/i.test(s);
}

export interface McpToolAnnotationHints {
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

export function classifyMcpToolSideEffect(
  annotations: McpToolAnnotationHints | null | undefined,
): SideEffect {
  if (!annotations) return "write";
  if (annotations.destructiveHint === true) return "write";
  return annotations.readOnlyHint === true ? "read" : "write";
}

export function classifyHttpSideEffect(input: SideEffectInput): SideEffect {
  if (input.override === "write") return "write";
  const overHttp = classifyGraphqlOverHttp(input);
  if (overHttp) return overHttp;
  if (input.override === "read" && readOverrideIsSafe(input)) return "read";
  if (input.mcp) {
    return input.mcp.operation === "call_tool" ? "write" : "read";
  }
  if (input.graphql) {
    return graphqlDocumentIsRead(input.graphql) ? "read" : "write";
  }
  if (input.sql) {
    const statements = [input.sql.query, ...(input.sql.also ?? []).map((s) => s.query)];
    return statements.every(sqlIsSelect) ? "read" : "write";
  }
  const method = (input.method ?? "GET").toUpperCase();
  if (input.s3) {
    return S3_READ_METHODS.has(method) ? "read" : "write";
  }
  return httpMethodIsRead(method) ? "read" : "write";
}

function readOverrideIsSafe(input: SideEffectInput): boolean {
  if (input.mcp || input.graphql || input.sql) return false;
  const method = (input.method ?? "GET").toUpperCase();
  if (input.s3) return S3_READ_METHODS.has(method);
  return httpMethodIsRead(method) || method === "POST";
}

function graphqlDocumentIsRead(input: NonNullable<SideEffectInput["graphql"]>): boolean {
  if (input.operation && input.operation !== "query") return false;
  return inferGraphqlOperation(input.query ?? "") === "query";
}
