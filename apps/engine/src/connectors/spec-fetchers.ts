import { getIntrospectionQuery } from "graphql";
import { getConfig } from "../config/loader.ts";
import { getDriverFetch } from "./drivers/fetch-seam.ts";
import {
  HttpRequestInvalidError,
  readBodyCapped,
  validateOutboundHeaders,
} from "./drivers/http.ts";

export interface FetchedSpec {
  content: string;
  content_type: string;
  fetched_from: string;
}

export const API_SPEC_MAX_BYTES = 50 * 1024 * 1024;
export const OPENAPI_SPEC_MAX_BYTES = API_SPEC_MAX_BYTES;
export const GOOGLE_DISCOVERY_SPEC_MAX_BYTES = API_SPEC_MAX_BYTES;
const TIMEOUT_MS = 15_000;

function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return true;
  if (lower === "169.254.169.254") return true;
  if (/^127\./.test(lower) || /^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(lower)) return true;
  return false;
}

export class SpecFetchError extends Error {
  readonly status: number | null;
  readonly url: string;
  constructor(message: string, url: string, status: number | null = null) {
    super(message);
    this.url = url;
    this.status = status;
  }
}

async function readSpecBody(
  res: Response,
  url: string,
  kind: "OpenAPI" | "Google Discovery",
  maxBytes: number,
): Promise<string> {
  try {
    return await readBodyCapped(res, maxBytes, url);
  } catch (err) {
    if (err instanceof HttpRequestInvalidError) {
      throw new SpecFetchError(
        `${kind} spec exceeds ${maxBytes === API_SPEC_MAX_BYTES ? "50 MiB" : `${maxBytes} bytes`}`,
        url,
        res.status,
      );
    }
    throw err;
  }
}

export async function readOpenApiSpecBody(
  res: Response,
  url: string,
  maxBytes = OPENAPI_SPEC_MAX_BYTES,
): Promise<string> {
  return await readSpecBody(res, url, "OpenAPI", maxBytes);
}

export async function readGoogleDiscoverySpecBody(
  res: Response,
  url: string,
  maxBytes = GOOGLE_DISCOVERY_SPEC_MAX_BYTES,
): Promise<string> {
  return await readSpecBody(res, url, "Google Discovery", maxBytes);
}

interface BudgetedResponse {
  response: Response;
  release: () => void;
}

async function fetchWithBudget(url: string, init: RequestInit): Promise<BudgetedResponse> {
  const u = new URL(url);
  let allowPrivate = false;
  try {
    allowPrivate = getConfig().spec.allow_private_fetch;
  } catch {}
  if (isPrivateHost(u.hostname) && !allowPrivate) {
    throw new SpecFetchError(`refusing to fetch private host ${u.hostname}`, url);
  }
  if (init.headers !== undefined) validateOutboundHeaders(init.headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await getDriverFetch()(url, { ...init, signal: controller.signal });
    return { response, release: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function fetchOpenApiSpec(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchedSpec> {
  const { response, release } = await fetchWithBudget(url, {
    method: "GET",
    ...(headers ? { headers } : {}),
  });
  try {
    if (!response.ok) {
      throw new SpecFetchError(`OpenAPI fetch returned ${response.status}`, url, response.status);
    }
    const content = await readOpenApiSpecBody(response, url);
    return {
      content,
      content_type: response.headers.get("content-type") ?? "application/json",
      fetched_from: url,
    };
  } finally {
    release();
  }
}

export async function fetchGoogleDiscoverySpec(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchedSpec> {
  const { response, release } = await fetchWithBudget(url, {
    method: "GET",
    ...(headers ? { headers } : {}),
  });
  try {
    if (!response.ok) {
      throw new SpecFetchError(
        `Google Discovery fetch returned ${response.status}`,
        url,
        response.status,
      );
    }
    const content = await readGoogleDiscoverySpecBody(response, url);
    return {
      content,
      content_type: response.headers.get("content-type") ?? "application/json",
      fetched_from: url,
    };
  } finally {
    release();
  }
}

export async function fetchGraphQLIntrospection(
  endpoint: string,
  headers?: Record<string, string>,
): Promise<FetchedSpec> {
  const { response, release } = await fetchWithBudget(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  try {
    if (!response.ok) {
      throw new SpecFetchError(
        `GraphQL introspection returned ${response.status}`,
        endpoint,
        response.status,
      );
    }
    const json = (await response.json()) as { data?: unknown; errors?: unknown };
    if (!json.data) {
      throw new SpecFetchError(
        `GraphQL introspection returned no data (errors: ${JSON.stringify(json.errors ?? null)})`,
        endpoint,
        response.status,
      );
    }
    return {
      content: JSON.stringify(json),
      content_type: "application/json",
      fetched_from: endpoint,
    };
  } finally {
    release();
  }
}
