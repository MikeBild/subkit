import { looksLikeGraphQLUrl } from "@shared/graphql-url.ts";
import { resolveUrl } from "./resolve-url.ts";

type GraphqlEndpointCode =
  | "connector_driver_mismatch"
  | "graphql_path_required"
  | "graphql_endpoint_invalid";

type GraphqlEndpoint =
  | { ok: true; url: string | null; via_path: boolean }
  | { ok: false; code: GraphqlEndpointCode; message: string };

export interface GraphqlConnectorTarget {
  driver: string;
  base_url?: string | null | undefined;
  auth_type?: string | null | undefined;
}

interface GraphqlStepAddress extends GraphqlConnectorTarget {
  path?: string | null | undefined;
  url?: string | null | undefined;
}

const FIXED_PATH = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*)(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/;

const GRAPHQL_PATH_REQUIRED_MESSAGE =
  'A graphql block on an http connector needs path "/graphql" (the GraphQL endpoint path on the connector host). Keep the graphql block with its cursor_pagination and set path "/graphql"; method is ignored, the request is always sent as POST.';

export const GRAPHQL_PATH_INVALID_MESSAGE =
  'The address must be a fixed GraphQL endpoint path on the connector host ending in "/graphql", for example path "/graphql" without url, query, placeholders or "..".';

const SIGNED_MESSAGE =
  "A graphql block cannot be sent through a request-signing http connector. Use a graphql connector for this endpoint.";

const DRIVER_MESSAGE =
  'A graphql block runs on a graphql connector or on an http connector with path "/graphql".';

const fail = (code: GraphqlEndpointCode, message: string): GraphqlEndpoint => ({
  ok: false,
  code,
  message,
});

export function graphqlPathShapeError(path: unknown): string | null {
  return typeof path === "string" &&
    FIXED_PATH.test(path) &&
    looksLikeGraphQLUrl(`https://graphql.invalid${path}`)
    ? null
    : GRAPHQL_PATH_INVALID_MESSAGE;
}

function webOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function resolveGraphqlStepEndpoint(address: GraphqlStepAddress): GraphqlEndpoint {
  if (address.driver === "graphql")
    return { ok: true, url: address.base_url || null, via_path: false };
  if (address.driver !== "http") return fail("connector_driver_mismatch", DRIVER_MESSAGE);
  if (address.url !== undefined && address.url !== null)
    return fail("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE);
  if (address.auth_type === "aws_sigv4") return fail("graphql_endpoint_invalid", SIGNED_MESSAGE);
  if (address.path === undefined || address.path === null || address.path === "")
    return fail("graphql_path_required", GRAPHQL_PATH_REQUIRED_MESSAGE);
  if (graphqlPathShapeError(address.path) !== null)
    return fail("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE);
  const origin = address.base_url ? webOrigin(address.base_url) : null;
  if (!origin || !address.base_url)
    return fail("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE);
  let resolved: URL;
  try {
    resolved = resolveUrl(address.base_url, address.path);
  } catch {
    return fail("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE);
  }
  if (
    resolved.origin !== origin ||
    resolved.search ||
    resolved.hash ||
    !looksLikeGraphQLUrl(resolved.href)
  )
    return fail("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE);
  return { ok: true, url: `${resolved.origin}${resolved.pathname}`, via_path: true };
}

export function sameOriginEndpoint(baseUrl: string | null | undefined, endpoint: string): boolean {
  const origin = baseUrl ? webOrigin(baseUrl) : null;
  return origin !== null && webOrigin(endpoint) === origin;
}
