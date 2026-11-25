import { z } from "@hono/zod-openapi";
import {
  ALLOWED_HOST_RULE,
  canonicalHostList,
  type DestinationHostIssue,
  destinationHostIssue,
  MAX_ALLOWED_HOSTS,
} from "@shared/allowed-hosts.ts";
import { resolveUrl } from "../connectors/drivers/resolve-url.ts";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import { onlyVaultHandles } from "./core/vault-uses.ts";
import type { McpBoundaryRefusal } from "./mcp-boundary.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import {
  boundedRequestHeaders,
  type HeaderBoundaryRefusal,
  RequestHeaderBoundsSchema,
  ReviewedHeadersSchema,
  reviewedHeaderViolation,
} from "./request-boundary-headers.ts";
import {
  bodyPagingRefusal,
  describePagedBodyViolation,
  type PagedBodyViolation,
  pagedBodyParts,
} from "./request-boundary-paging.ts";
import {
  CLASS_SAMPLE,
  expression,
  isCallerExpression,
  pathValueAllowed,
  type RequestVariableRule,
  rule,
  ruleLabel,
  VALUE_CLASSES,
  type ValueClass,
  valueAllowed,
  variablesError,
  WHOLE_SEGMENT,
} from "./request-value-rules.ts";
import type { RequestStep } from "./types.ts";

export {
  describePagedBodyViolation,
  type PagedBodyViolation,
  pagedBodyGuard,
} from "./request-boundary-paging.ts";

export {
  expression as VariableExpressionSchema,
  pathValueAllowed,
  type RequestVariableRule,
  rule as RequestVariableRuleSchema,
  VALUE_CLASSES,
  variablesError,
} from "./request-value-rules.ts";

export function callerRulesConsistent(variables: Record<string, RequestVariableRule>): boolean {
  return Object.entries(variables).every(
    ([name, entry]) => isCallerExpression(name) === "caller_bound" in entry,
  );
}

function fixedForDelete(entry: RequestVariableRule): boolean {
  return "enum" in entry || "caller_bound" in entry;
}

const allowedHostList = z
  .array(z.string().min(1).max(253))
  .min(1)
  .max(MAX_ALLOWED_HOSTS)
  .refine((hosts) => canonicalHostList(hosts) !== null, {
    message: `allowed_hosts ${ALLOWED_HOST_RULE}`,
  });
const allowedHostsPlaceholder = z.string().regex(/^\$\{input\.[A-Za-z_][A-Za-z0-9_]*\}$/);

export const RequestBoundaryScopeSchema = z
  .object({
    variables: z.record(expression, rule, { error: variablesError }),
    headers: RequestHeaderBoundsSchema.optional(),
    allowed_hosts: z
      .union([allowedHostList, allowedHostsPlaceholder])
      .optional()
      .describe(
        "Hosts a runtime url may reach. Only with a `url` that is one whole `${input.*}` or `${item.*}` placeholder; the request must then be https on exactly one of these hosts. A recipe leaves `${input.<key>}` here and pins the list at install time.",
      ),
    max_body_bytes: z.number().int().min(0).max(10_000_000),
    max_calls: z.number().int().min(1).max(10_000),
    destructive: z
      .literal(true, {
        error:
          "`destructive` exists only to mark a request that removes or irreversibly changes data, " +
          "and may then only be `true`. For any other request OMIT the key; do not set it to false " +
          "and do not set it to true to satisfy this check.",
      })
      .optional(),
  })
  .strict();
export type RequestBoundaryScope = z.infer<typeof RequestBoundaryScopeSchema>;

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

const queryKey = z.string().min(1).max(200);
export const ConnectorQuerySchema = z
  .object({
    fixed: z.record(queryKey, z.string().regex(/^[a-f0-9]{64}$/)),
    credential: z.array(queryKey).max(20),
  })
  .strict();
export type ConnectorQuery = z.infer<typeof ConnectorQuerySchema>;

export function connectorQueryOf(
  staticQuery: unknown,
  credentialKeys: readonly string[],
): ConnectorQuery | null {
  const fixed: Record<string, string> = {};
  if (staticQuery)
    for (const [key, value] of Object.entries(staticQuery))
      fixed[key] = workflowJsonDigest(String(value));
  const parsed = ConnectorQuerySchema.safeParse({ fixed, credential: [...credentialKeys] });
  return parsed.success ? parsed.data : null;
}

function connectorQueryKeys(query: ConnectorQuery | undefined): string[] {
  return query ? [...Object.keys(query.fixed), ...query.credential] : [];
}

function connectorQueryConsistent(boundary: {
  connector_query?: ConnectorQuery | undefined;
  query: {
    fixed: Record<string, string>;
    variable: Array<{ key: string }>;
    vault?: string[] | undefined;
  };
  pagination?: { params: string[]; location?: "body" | undefined } | undefined;
}): boolean {
  const own = connectorQueryKeys(boundary.connector_query);
  if (!boundary.connector_query) return true;
  if (own.length === 0 || new Set(own).size !== own.length) return false;
  const sorted = [...boundary.connector_query.credential].sort();
  if (sorted.some((key, index) => key !== boundary.connector_query?.credential[index]))
    return false;
  const taken = new Set([
    ...Object.keys(boundary.query.fixed),
    ...boundary.query.variable.map((entry) => entry.key),
    ...(boundary.query.vault ?? []),
    ...(boundary.pagination?.location === "body" ? [] : (boundary.pagination?.params ?? [])),
  ]);
  return !own.some((key) => taken.has(key));
}

export const RequestBoundarySchema = z
  .object({
    base_url: z.string().url().nullable(),
    method: z.enum(HTTP_METHODS),
    origin: z.string().url().optional(),
    destination: z
      .object({
        var: expression,
        hosts: z
          .array(z.string())
          .min(1)
          .max(MAX_ALLOWED_HOSTS)
          .refine((hosts) => canonicalHostList(hosts)?.join(" ") === hosts.join(" ")),
      })
      .strict()
      .optional(),
    body_encoding: z.literal("multipart").optional(),
    idempotency_key: z.object({ var: expression }).strict().optional(),
    headers: ReviewedHeadersSchema.optional(),
    segments: z
      .array(z.union([z.string(), z.object({ var: expression }).strict()]))
      .min(2)
      .max(50)
      .optional(),
    variables: z.record(expression, rule, { error: variablesError }),
    query: z
      .object({
        fixed: z.record(z.string(), z.string()),
        variable: z.array(z.object({ key: z.string().min(1), var: expression }).strict()).max(50),
        vault: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
      })
      .strict(),
    connector_query: ConnectorQuerySchema.optional(),
    max_body_bytes: z.number().int().min(0).max(10_000_000),
    max_calls: z.number().int().min(1).max(10_000),
    pagination: z
      .object({
        params: z.array(z.string().min(1)).min(1).max(4),
        max_requests: z.number().int().min(1).max(1000),
        location: z.literal("body").optional(),
      })
      .strict()
      .optional(),
    destructive: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (boundary) =>
      boundary.destination
        ? boundary.origin === undefined &&
          boundary.segments === undefined &&
          boundary.method !== "DELETE" &&
          boundary.pagination === undefined &&
          boundary.connector_query === undefined
        : boundary.origin !== undefined && boundary.segments !== undefined,
    { message: "a request boundary names either a fixed origin and path or a bounded destination" },
  )
  .refine((boundary) => boundary.method !== "DELETE" || boundary.destructive === true, {
    message: "a DELETE request boundary requires destructive: true",
  })
  .refine(
    (boundary) =>
      boundary.method !== "DELETE" || Object.values(boundary.variables).every(fixedForDelete),
    {
      message:
        "a DELETE request boundary may only vary over listed values or the authenticated caller",
    },
  )
  .refine((boundary) => callerRulesConsistent(boundary.variables), {
    message: "caller.* variables need the rule { caller_bound: true }, and only they may use it",
  })
  .refine(
    (boundary) =>
      boundary.pagination?.location !== "body" ||
      (boundary.body_encoding === undefined && !["GET", "HEAD"].includes(boundary.method)),
    { message: "paging through the body needs a JSON body on a method that carries one" },
  )
  .refine((boundary) => connectorQueryConsistent(boundary), {
    message:
      "connector query keys must be distinct from each other and from the step's own query and paging keys",
  });
export type RequestBoundary = z.infer<typeof RequestBoundarySchema>;

export type RequestBoundaryRefusal =
  | "not_http_step"
  | "pagination_unsupported"
  | "pagination_unbounded"
  | "pagination_param_conflict"
  | "pagination_body_unsupported"
  | "query_placeholder_unsupported"
  | HeaderBoundaryRefusal
  | "runtime_value_outside_path_and_body"
  | "path_unsupported"
  | "partial_segment_placeholder"
  | "no_boundary"
  | "boundary_invalid"
  | "variables_mismatch"
  | "delete_requires_destructive"
  | "delete_requires_enum"
  | "caller_bound_mismatch"
  | "target_unresolved"
  | "variable_in_base_prefix"
  | "enum_value_unroutable"
  | "path_class_misplaced"
  | "connector_query_conflict"
  | "connector_query_unresolved"
  | "connector_query_needs_boundary"
  | "allowed_hosts_unpinned"
  | "runtime_destination_unsupported"
  | McpBoundaryRefusal
  | "report_delivery_unprepared"
  | "report_delivery_unobserved"
  | "report_delivery_unreachable"
  | "report_delivery_contradicted"
  | "stricter_profile_applies";

const MASK = "__subkit_var_";

function refuse(refusal: RequestBoundaryRefusal) {
  return { refusal } as const;
}

function authoredSegments(
  path: string,
):
  | { segments: Array<string | { var: string }>; refusal?: never }
  | { refusal: RequestBoundaryRefusal } {
  if (/[?#%\\]/.test(path) || path.includes(MASK)) return refuse("path_unsupported");
  const segments: Array<string | { var: string }> = [];
  for (const part of path.split("/")) {
    const whole = WHOLE_SEGMENT.exec(part);
    if (whole?.[1] !== undefined) {
      if (!expression.safeParse(whole[1]).success) return refuse("partial_segment_placeholder");
      segments.push({ var: whole[1] });
    } else if (part.includes("${")) return refuse("partial_segment_placeholder");
    else segments.push(part);
  }
  return { segments };
}

function paginationShape(
  pagination: NonNullable<RequestStep["pagination"]>,
): { params: string[]; max_requests: number; location?: "body" } | null | "unbounded" {
  if (pagination.strategy === "link") {
    const params = [
      ...pagination.link_params,
      ...(pagination.limit_param ? [pagination.limit_param] : []),
    ];
    if (pagination.max_pages === undefined) return "unbounded";
    return { params: [...new Set(params)].sort(), max_requests: pagination.max_pages };
  }
  const params =
    pagination.strategy === "cursor"
      ? [
          pagination.cursor_request_param,
          ...(pagination.limit_param ? [pagination.limit_param] : []),
        ]
      : pagination.strategy === "offset"
        ? [pagination.offset_param, pagination.limit_param]
        : [pagination.page_param, pagination.limit_param];
  if (params.some((name) => typeof name !== "string" || name.length === 0)) return null;
  if (pagination.max_pages === undefined) return "unbounded";
  return {
    params: [...new Set(params)].sort(),
    max_requests: pagination.max_pages,
    ...(pagination.parameter_location === "body" ? { location: "body" as const } : {}),
  };
}

function stepWithoutRuntimeParts(step: RequestStep) {
  const {
    body: _body,
    path: _path,
    url: _url,
    query: _query,
    headers: _headers,
    form: _form,
    idempotency_key: _idempotencyKey,
    multipart: _multipart,
    for_each: _forEach,
    data_selector: _dataSelector,
    ...fixed
  } = step;
  return fixed;
}

type CompiledRequestBoundary =
  | { boundary: RequestBoundary; refusal?: never }
  | { boundary?: never; refusal: RequestBoundaryRefusal };

function compileDestinationBoundary(
  step: RequestStep,
  base_url: string | null,
  connector_query: ConnectorQuery | null | undefined,
): CompiledRequestBoundary {
  const scope = RequestBoundaryScopeSchema.safeParse(step.boundary);
  if (!scope.success) return refuse("boundary_invalid");
  if (typeof scope.data.allowed_hosts === "string") return refuse("allowed_hosts_unpinned");
  const hosts = canonicalHostList(scope.data.allowed_hosts);
  if (!hosts) return refuse("boundary_invalid");
  const whole =
    step.path === undefined && step.url !== undefined ? WHOLE_SEGMENT.exec(step.url) : null;
  const destination = whole?.[1];
  if (
    !destination ||
    !expression.safeParse(destination).success ||
    isCallerExpression(destination) ||
    base_url !== null ||
    step.connector_id !== undefined ||
    connectorQueryKeys(connector_query ?? undefined).length > 0 ||
    step.multipart ||
    step.pagination ||
    Object.keys(step.query ?? {}).length > 0
  )
    return refuse("runtime_destination_unsupported");
  const header = boundedRequestHeaders(step, scope.data.headers);
  if (header.refusal) return refuse(header.refusal);
  if (hasRuntimeValue(stepWithoutRuntimeParts(step)))
    return refuse("runtime_value_outside_path_and_body");
  const used = header.idempotency_key ? [header.idempotency_key.var] : [];
  const declared = Object.keys(scope.data.variables);
  if (used.length !== declared.length || used.some((name) => !declared.includes(name)))
    return refuse("variables_mismatch");
  const method = (step.method ?? "GET").toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) return refuse("not_http_step");
  if (method === "DELETE")
    return refuse(scope.data.destructive ? "delete_requires_enum" : "delete_requires_destructive");
  if (!callerRulesConsistent(scope.data.variables)) return refuse("caller_bound_mismatch");
  const candidate = RequestBoundarySchema.safeParse({
    base_url: null,
    method,
    destination: { var: destination, hosts },
    ...(header.idempotency_key ? { idempotency_key: header.idempotency_key } : {}),
    ...(header.headers ? { headers: header.headers } : {}),
    variables: scope.data.variables,
    query: { fixed: {}, variable: [] },
    max_body_bytes: scope.data.max_body_bytes,
    max_calls: scope.data.max_calls,
    ...(scope.data.destructive ? { destructive: true as const } : {}),
  });
  return candidate.success ? { boundary: candidate.data } : refuse("boundary_invalid");
}

export function compileRequestBoundary(
  step: RequestStep,
  base_url: string | null,
  connector_query?: ConnectorQuery | null,
): CompiledRequestBoundary {
  if (step.s3 || step.sql || step.mcp || step.graphql || step.xml) return refuse("not_http_step");
  if (step.boundary?.allowed_hosts !== undefined)
    return compileDestinationBoundary(step, base_url, connector_query);
  if (step.multipart && step.pagination) return refuse("pagination_unsupported");
  const paging = step.pagination ? paginationShape(step.pagination) : null;
  if (step.pagination && !paging) return refuse("pagination_unsupported");
  if (step.pagination && paging === "unbounded") return refuse("pagination_unbounded");
  const pagesThroughBody = paging !== null && paging !== "unbounded" && paging.location === "body";
  if (pagesThroughBody) {
    const refusal = bodyPagingRefusal(step, paging.params);
    if (refusal) return refuse(refusal);
  }
  const fixedQuery: Record<string, string> = {};
  const variableQuery: Array<{ key: string; var: string }> = [];
  const vaultQuery: string[] = [];
  for (const [key, value] of Object.entries(step.query ?? {})) {
    const whole = typeof value === "string" ? WHOLE_SEGMENT.exec(value) : null;
    if (whole?.[1] !== undefined && expression.safeParse(whole[1]).success)
      variableQuery.push({ key, var: whole[1] });
    else if (!hasRuntimeValue(key) && onlyVaultHandles(value)) vaultQuery.push(key);
    else if (hasRuntimeValue(value) || hasRuntimeValue(key))
      return refuse("query_placeholder_unsupported");
    else fixedQuery[key] = String(value);
  }
  variableQuery.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  vaultQuery.sort();
  const header = boundedRequestHeaders(step, step.boundary?.headers);
  if (header.refusal) return refuse(header.refusal);
  const idempotencyKey = header.idempotency_key;
  if (hasRuntimeValue(stepWithoutRuntimeParts(step)))
    return refuse("runtime_value_outside_path_and_body");
  const authored = step.path ?? step.url;
  if (!authored || (step.path !== undefined && step.url !== undefined))
    return refuse("path_unsupported");
  const split = authoredSegments(authored);
  if (split.refusal) return refuse(split.refusal);

  if (!step.boundary) return refuse("no_boundary");
  const scope = RequestBoundaryScopeSchema.safeParse(step.boundary);
  if (!scope.success) return refuse("boundary_invalid");
  const connectorQuery = ConnectorQuerySchema.safeParse(
    connector_query ?? { fixed: {}, credential: [] },
  );
  if (!connectorQuery.success) return refuse("connector_query_unresolved");
  const ownQuery: ConnectorQuery = {
    fixed: connectorQuery.data.fixed,
    credential: [...new Set(connectorQuery.data.credential)].sort(),
  };
  const ownQueryKeys = connectorQueryKeys(ownQuery);
  const used = [
    ...split.segments.flatMap((part) => (typeof part === "string" ? [] : [part.var])),
    ...variableQuery.map((entry) => entry.var),
    ...(idempotencyKey ? [idempotencyKey.var] : []),
  ];
  const declared = Object.keys(scope.data.variables);
  if (
    new Set(used).size !== used.length ||
    used.length !== declared.length ||
    used.some((name) => !declared.includes(name))
  )
    return refuse("variables_mismatch");
  const method = (step.method ?? "GET").toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) return refuse("not_http_step");
  if (method === "DELETE" && scope.data.destructive !== true)
    return refuse("delete_requires_destructive");
  if (!callerRulesConsistent(scope.data.variables)) return refuse("caller_bound_mismatch");
  if (method === "DELETE" && !Object.values(scope.data.variables).every(fixedForDelete))
    return refuse("delete_requires_enum");

  {
    const lastSegment = split.segments[split.segments.length - 1];
    const tailVar = typeof lastSegment === "string" ? null : (lastSegment?.var ?? null);
    const misplaced = Object.entries(scope.data.variables).some(
      ([name, entry]) => "class" in entry && entry.class === "path" && name !== tailVar,
    );
    if (misplaced) return refuse("path_class_misplaced");
  }

  const masked = split.segments
    .map((part, index) => (typeof part === "string" ? part : `${MASK}${index}__`))
    .join("/");
  let resolved: URL;
  try {
    resolved = resolveUrl(base_url, masked);
  } catch {
    return refuse("target_unresolved");
  }
  if (
    !["http:", "https:"].includes(resolved.protocol) ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    resolved.search ||
    resolved.host.includes(MASK)
  )
    return refuse("target_unresolved");
  if (base_url) {
    try {
      const baseDepth = new URL(base_url).pathname.split("/").filter(Boolean).length;
      const leading = split.segments.filter((part) => part !== "").slice(0, baseDepth);
      if (leading.some((part) => typeof part !== "string"))
        return refuse("variable_in_base_prefix");
    } catch {
      return refuse("target_unresolved");
    }
  }
  const byToken = new Map<string, string>(
    split.segments.flatMap(
      (part, index): Array<[string, string]> =>
        typeof part === "string" ? [] : [[`${MASK}${index}__`, part.var]],
    ),
  );
  const segments = resolved.pathname.split("/").map((part) => {
    const name = byToken.get(part);
    return name === undefined ? part : { var: name };
  });
  if (segments.some((part) => typeof part === "string" && part.includes(MASK)))
    return refuse("target_unresolved");

  if (
    paging &&
    paging !== "unbounded" &&
    !pagesThroughBody &&
    paging.params.some(
      (name) =>
        name in fixedQuery ||
        vaultQuery.includes(name) ||
        variableQuery.some((entry) => entry.key === name),
    )
  )
    return refuse("pagination_param_conflict");
  if (
    new Set(ownQueryKeys).size !== ownQueryKeys.length ||
    ownQueryKeys.some(
      (name) =>
        name in fixedQuery ||
        vaultQuery.includes(name) ||
        variableQuery.some((entry) => entry.key === name) ||
        (paging && paging !== "unbounded" && !pagesThroughBody && paging.params.includes(name)),
    )
  )
    return refuse("connector_query_conflict");
  const candidate = RequestBoundarySchema.safeParse({
    base_url,
    method,
    origin: resolved.origin,
    ...(step.multipart ? { body_encoding: "multipart" as const } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(header.headers ? { headers: header.headers } : {}),
    segments,
    variables: scope.data.variables,
    query: {
      fixed: fixedQuery,
      variable: variableQuery,
      ...(vaultQuery.length > 0 ? { vault: vaultQuery } : {}),
    },
    ...(ownQueryKeys.length > 0 ? { connector_query: ownQuery } : {}),
    max_body_bytes: scope.data.max_body_bytes,
    max_calls: scope.data.max_calls,
    ...(paging && paging !== "unbounded" ? { pagination: paging } : {}),
    ...(scope.data.destructive ? { destructive: true as const } : {}),
  });
  if (!candidate.success) return refuse("boundary_invalid");

  const samples = (name: string): string[] => {
    const entry = scope.data.variables[name];
    if (!entry) return [""];
    if ("enum" in entry) return entry.enum;
    return "caller_bound" in entry ? [CLASS_SAMPLE.uuid] : [CLASS_SAMPLE[entry.class]];
  };
  for (const name of declared) {
    for (const value of samples(name)) {
      const pick = (other: string) => (other === name ? value : (samples(other)[0] ?? ""));
      const concrete = split.segments
        .map((part) => (typeof part === "string" ? part : pick(part.var)))
        .join("/");
      try {
        const url = resolveUrl(base_url, concrete);
        for (const [key, fixed] of Object.entries(fixedQuery)) url.searchParams.set(key, fixed);
        for (const entry of variableQuery) url.searchParams.set(entry.key, pick(entry.var));
        for (const key of vaultQuery) url.searchParams.set(key, "vault");
        const { connector_query: _connectorQuery, ...ownRequest } = candidate.data;
        if (!matchTarget(ownRequest, url) || !matchQuery(ownRequest, url))
          return refuse("enum_value_unroutable");
      } catch {
        return refuse("enum_value_unroutable");
      }
    }
  }
  return { boundary: candidate.data };
}

export function requestBoundary(
  step: RequestStep,
  base_url: string | null,
  connector_query?: ConnectorQuery | null,
): RequestBoundary | null {
  return compileRequestBoundary(step, base_url, connector_query).boundary ?? null;
}

export function requestBoundaryTarget(boundary: RequestBoundary): string {
  if (boundary.destination)
    return `{${boundary.destination.var}} on ${boundary.destination.hosts
      .map((host) => `https://${host}`)
      .join(", ")}`;
  return `${boundary.origin ?? ""}${(boundary.segments ?? [])
    .map((part) => (typeof part === "string" ? part : `{${part.var}}`))
    .join("/")}`;
}

export function variableValueAllowed(
  variableRule: RequestVariableRule | undefined,
  value: string,
): boolean {
  return valueAllowed(variableRule, value);
}

function isPathRule(variableRule: RequestVariableRule | undefined): boolean {
  return variableRule !== undefined && "class" in variableRule && variableRule.class === "path";
}

function matchTarget(boundary: RequestBoundary, url: URL): boolean {
  const segments = boundary.segments;
  if (!segments || url.origin !== boundary.origin || url.username || url.password || url.hash)
    return false;
  const actual = url.pathname.split("/");
  const last = segments[segments.length - 1];
  const tailRule =
    last !== undefined && typeof last !== "string" ? boundary.variables[last.var] : undefined;
  if (isPathRule(tailRule)) {
    const fixed = segments.length - 1;
    if (actual.length < fixed + 1) return false;
    for (let index = 0; index < fixed; index += 1) {
      const expected = segments[index];
      const raw = actual[index] ?? "";
      const ok =
        typeof expected === "string"
          ? raw === expected
          : valueAllowed(boundary.variables[(expected as { var: string }).var], raw);
      if (!ok) return false;
    }
    return pathValueAllowed(actual.slice(fixed).join("/"));
  }
  if (actual.length !== segments.length) return false;
  return segments.every((expected, index) => {
    const raw = actual[index] ?? "";
    return typeof expected === "string"
      ? raw === expected
      : valueAllowed(boundary.variables[expected.var], raw);
  });
}

export type TargetVariableIssue = {
  name: string;
  length: number;
  rule: string;
  fits_class?: ValueClass;
};

function targetVariableIssue(boundary: RequestBoundary, url: URL): TargetVariableIssue | undefined {
  const segments = boundary.segments;
  if (!segments || url.origin !== boundary.origin) return undefined;
  const actual = url.pathname.split("/");
  if (actual.length !== segments.length) return undefined;
  for (const [index, expected] of segments.entries()) {
    const raw = actual[index] ?? "";
    if (typeof expected === "string") {
      if (raw !== expected) return undefined;
      continue;
    }
    const variableRule = boundary.variables[expected.var];
    if (valueAllowed(variableRule, raw)) continue;
    const wider =
      variableRule && "class" in variableRule && variableRule.class === "identifier"
        ? VALUE_CLASSES.long_identifier.test(raw)
        : false;
    return {
      name: expected.var,
      length: raw.length,
      rule: ruleLabel(variableRule),
      ...(wider ? { fits_class: "long_identifier" as const } : {}),
    };
  }
  return undefined;
}

export type RequestQueryViolation =
  | { reason: "unexpected_key" | "missing_key" | "duplicate_key" | "fixed_value"; key: string }
  | { reason: "variable_value"; key: string; value: string; rule: string };

function queryViolation(boundary: RequestBoundary, url: URL): RequestQueryViolation | null {
  const keys = [...url.searchParams.keys()];
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) return { reason: "duplicate_key", key: duplicate };
  const fixedKeys = Object.keys(boundary.query.fixed);
  const pinned = boundary.connector_query?.fixed ?? {};
  const reviewed = new Set([
    ...fixedKeys,
    ...Object.keys(pinned),
    ...boundary.query.variable.map((entry) => entry.key),
    ...(boundary.query.vault ?? []),
    ...(boundary.connector_query?.credential ?? []),
  ]);
  const paging = new Set(
    boundary.pagination?.location === "body" ? [] : (boundary.pagination?.params ?? []),
  );
  const unexpected = keys.find((key) => !reviewed.has(key) && !paging.has(key));
  if (unexpected !== undefined) return { reason: "unexpected_key", key: unexpected };
  const missing = [...reviewed].find((key) => !url.searchParams.has(key));
  if (missing !== undefined) return { reason: "missing_key", key: missing };
  const changed =
    fixedKeys.find((key) => url.searchParams.get(key) !== boundary.query.fixed[key]) ??
    Object.keys(pinned).find(
      (key) => workflowJsonDigest(url.searchParams.get(key) ?? "") !== pinned[key],
    );
  if (changed !== undefined) return { reason: "fixed_value", key: changed };
  for (const entry of boundary.query.variable) {
    const value = url.searchParams.get(entry.key) ?? "";
    const variableRule = boundary.variables[entry.var];
    if (!valueAllowed(variableRule, value))
      return {
        reason: "variable_value",
        key: entry.key,
        value: value.slice(0, 100),
        rule: ruleLabel(variableRule),
      };
  }
  return null;
}
function matchQuery(boundary: RequestBoundary, url: URL): boolean {
  return queryViolation(boundary, url) === null;
}

export type RequestBoundaryViolation =
  | {
      kind:
        | "boundary_invalid"
        | "request_missing"
        | "unsupported_body"
        | "url_invalid"
        | "idempotency_key";
    }
  | { kind: "header"; name: string }
  | { kind: "method"; actual: string; reviewed: string }
  | { kind: "target"; reviewed: string; actual: string; variable?: TargetVariableIssue }
  | { kind: "destination"; issue: DestinationHostIssue; actual: string; hosts: string[] }
  | { kind: "query"; detail: RequestQueryViolation }
  | { kind: "body_forbidden"; method: string }
  | { kind: "body_size"; bytes: number; max_body_bytes: number }
  | { kind: "paged_body"; detail: PagedBodyViolation };

export function requestBoundaryViolation(
  boundary: RequestBoundary,
  request: MaterializedRequest | undefined,
): RequestBoundaryViolation | null {
  const parsed = RequestBoundarySchema.safeParse(boundary);
  if (!parsed.success) return { kind: "boundary_invalid" };
  if (!request) return { kind: "request_missing" };
  if (request.unsupported_body) return { kind: "unsupported_body" };
  const reviewed = parsed.data;
  if (reviewed.body_encoding !== request.body_encoding) return { kind: "unsupported_body" };
  if (reviewed.idempotency_key) {
    const keys = Object.entries(request.headers).filter(
      ([name]) => name.toLowerCase() === "idempotency-key",
    );
    const value = keys[0]?.[1];
    if (
      keys.length !== 1 ||
      !value ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value) ||
      !valueAllowed(reviewed.variables[reviewed.idempotency_key.var], value)
    )
      return { kind: "idempotency_key" };
  }
  const header = reviewedHeaderViolation(reviewed.headers, request.headers);
  if (header !== null) return { kind: "header", name: header };
  const method = request.method.toUpperCase();
  if (method !== reviewed.method)
    return { kind: "method", actual: method, reviewed: reviewed.method };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "url_invalid" };
  }
  if (reviewed.destination) {
    const issue = destinationHostIssue(reviewed.destination.hosts, url);
    if (issue)
      return {
        kind: "destination",
        issue,
        actual: `${url.protocol}//${url.host}`.slice(0, 300),
        hosts: reviewed.destination.hosts,
      };
  } else if (!matchTarget(reviewed, url)) {
    const variable = targetVariableIssue(reviewed, url);
    return {
      kind: "target",
      reviewed: requestBoundaryTarget(reviewed),
      actual: `${url.origin}${url.pathname}`.slice(0, 300),
      ...(variable ? { variable } : {}),
    };
  }
  const query = reviewed.destination ? null : queryViolation(reviewed, url);
  if (query) return { kind: "query", detail: query };
  if (reviewed.method === "GET" || reviewed.method === "HEAD")
    return request.body !== null && request.body !== undefined
      ? { kind: "body_forbidden", method: reviewed.method }
      : null;
  if (request.body_encoding === "multipart") {
    const bytes = request.body_bytes;
    if (
      request.body === null ||
      request.body === undefined ||
      bytes === undefined ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      return { kind: "unsupported_body" };
    return bytes > reviewed.max_body_bytes
      ? { kind: "body_size", bytes, max_body_bytes: reviewed.max_body_bytes }
      : null;
  }
  if (reviewed.pagination?.location === "body") {
    const parts = pagedBodyParts(reviewed.pagination?.params ?? [], request.body);
    if ("reason" in parts) return { kind: "paged_body", detail: parts };
  }
  if (request.body === null || request.body === undefined) return null;
  const wire = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  if (wire === undefined) return { kind: "unsupported_body" };
  const bytes = Buffer.byteLength(wire, "utf8");
  return bytes > reviewed.max_body_bytes
    ? { kind: "body_size", bytes, max_body_bytes: reviewed.max_body_bytes }
    : null;
}

const DESTINATION_ISSUE: Record<DestinationHostIssue, string> = {
  scheme: "only https is allowed",
  userinfo: "a user name or password in the URL is not allowed",
  port: "an explicit port is not allowed",
  host: "the host is not on the list",
};

export function describeRequestBoundaryViolation(violation: RequestBoundaryViolation): string {
  switch (violation.kind) {
    case "idempotency_key":
      return "the idempotency key is missing, ambiguous or outside its reviewed value rule";
    case "header":
      return `the header \`${violation.name}\` is missing, repeated or outside its reviewed value rule`;
    case "body_size":
      return `the body is ${violation.bytes} bytes but \`boundary.max_body_bytes\` is ${violation.max_body_bytes}`;
    case "target": {
      const base = `the resolved URL ${violation.actual} is not ${violation.reviewed} with an approved value for every variable`;
      const variable = violation.variable;
      if (!variable) return base;
      const named = `${base}: \`${variable.name}\` is ${variable.length} characters and outside its rule (${variable.rule})`;
      return variable.fits_class
        ? `${named}; the value fits the class \`${variable.fits_class}\`, so change that one rule to \`{class: "${variable.fits_class}"}\``
        : named;
    }
    case "destination":
      return `the resolved URL ${violation.actual} is not an https address without port or credentials on one of the allowed hosts (${violation.hosts.join(", ")}): ${DESTINATION_ISSUE[violation.issue]}`;
    case "method":
      return `the method is ${violation.actual} but the boundary was compiled for ${violation.reviewed}`;
    case "query": {
      const { detail } = violation;
      if (detail.reason === "variable_value")
        return `the query value \`${detail.key}\` is "${detail.value}", which is outside its rule (${detail.rule})`;
      if (detail.reason === "fixed_value")
        return `the query parameter \`${detail.key}\` no longer has the fixed value that was reviewed`;
      if (detail.reason === "missing_key")
        return `the reviewed query parameter \`${detail.key}\` is missing from the request`;
      if (detail.reason === "duplicate_key")
        return `the query parameter \`${detail.key}\` appears more than once`;
      return `the request carries a query parameter \`${detail.key}\` that was not reviewed`;
    }
    case "body_forbidden":
      return `a ${violation.method} request under a boundary may not carry a body`;
    case "paged_body":
      return describePagedBodyViolation(violation.detail);
    case "unsupported_body":
      return "the body encoding or measured size does not match the reviewed request";
    default:
      return "the request could not be compared with the boundary";
  }
}

export function assertRequestBoundary(
  boundary: RequestBoundary,
  request: MaterializedRequest | undefined,
): void {
  if (requestBoundaryViolation(boundary, request) !== null)
    throw Object.assign(
      new Error("Request differs from its reviewed target, method or size boundary"),
      { code: "execution_authority_changed" },
    );
}
