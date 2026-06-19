// Spec fetchers: pull OpenAPI or GraphQL introspection documents from a
// remote URL at connector-creation time. Results feed docs-ingestion.
//
// SSRF guard: private RFC-1918 / link-local addresses are blocked unless
// SUBKIT_ALLOW_PRIVATE_SPEC_FETCH=1 is set.

import { getIntrospectionQuery } from "graphql";
import { getConfig } from "../config/loader.ts";
import { getDriverFetch } from "./drivers/fetch-seam.ts";
import { validateOutboundHeaders } from "./drivers/http.ts";

export interface FetchedSpec {
  content: string;
  content_type: string;
  fetched_from: string;
}

const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
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

async function fetchWithBudget(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  let allowPrivate = false;
  try {
    allowPrivate = getConfig().spec.allow_private_fetch;
  } catch {
    /* loader not initialised — keep default deny */
  }
  if (isPrivateHost(u.hostname) && !allowPrivate) {
    throw new SpecFetchError(`refusing to fetch private host ${u.hostname}`, url);
  }
  // Defence on every fetch path. The LLM-issued
  // `import_connector_from_spec` tool accepts an arbitrary
  // `Record<string,string>` headers field; without this guard a
  // non-RFC-token header name crashes inside `new Headers()` with
  // the obtuse "Invalid header name" error and the LLM has no
  // actionable repair signal. (Audit anti-pattern C2.)
  if (init.headers !== undefined) validateOutboundHeaders(init.headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await getDriverFetch()(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOpenApiSpec(
  url: string,
  headers?: Record<string, string>,
): Promise<FetchedSpec> {
  const res = await fetchWithBudget(url, { method: "GET", ...(headers ? { headers } : {}) });
  if (!res.ok) {
    throw new SpecFetchError(`OpenAPI fetch returned ${res.status}`, url, res.status);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_SIZE_BYTES) {
    throw new SpecFetchError(`OpenAPI spec exceeds 8 MB`, url, res.status);
  }
  const content = new TextDecoder().decode(buf);
  return {
    content,
    content_type: res.headers.get("content-type") ?? "application/json",
    fetched_from: url,
  };
}

export async function fetchGraphQLIntrospection(
  endpoint: string,
  headers?: Record<string, string>,
): Promise<FetchedSpec> {
  const res = await fetchWithBudget(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  if (!res.ok) {
    throw new SpecFetchError(`GraphQL introspection returned ${res.status}`, endpoint, res.status);
  }
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (!json.data) {
    throw new SpecFetchError(
      `GraphQL introspection returned no data (errors: ${JSON.stringify(json.errors ?? null)})`,
      endpoint,
      res.status,
    );
  }
  return {
    content: JSON.stringify(json),
    content_type: "application/json",
    fetched_from: endpoint,
  };
}
