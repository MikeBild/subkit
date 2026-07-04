// KnowledgeIngressStack — cascading cold-start for unknown APIs.
//
// Given only a base URL, try a prioritized list of documentation shapes
// until one yields non-empty chunks. The assistant calls this when a user
// says "point me at https://api.example.com" and expects the engine to
// figure out what's there on its own.
//
// Order:
//   1. OpenAPI  — probe common spec paths; if HTML comes back, scan it for
//                 spec links and retry. Handles most commercial APIs.
//   2. GraphQL  — POST an introspection query against /graphql.
//   3. llms.txt — standardized hint file at /llms-full.txt or /llms.txt (root,
//                 or mirrored under /.well-known/); full-content variant first.
//   4. Markdown — classic README-style paths (/README.md, /docs.md, etc.).
//   5. Raw-HTTP — final fallback: fetch the base URL, treat as plain text.
//
// Every probe routes through the same BudgetState so combined byte/link/spec
// caps hold across strategies. Headless-browser HTML crawl is deliberately
// not part of this cascade — the cost (playwright pull + browser launch +
// JS-rendered indeterminism) outweighs the marginal coverage over the four
// shapes above.

import { load as loadYaml } from "js-yaml";
import { canConsumeBytes, consumeBytes, createBudgetState, markBudgetExceeded } from "./budgets.ts";
import { byteLen } from "./chunker.ts";
import { ingestGraphQLIntrospection } from "./sources/graphql.ts";
import { ingestLlmsTxt } from "./sources/llms-txt.ts";
import { ingestMarkdown } from "./sources/markdown.ts";
import { ingestOpenAPIUrl } from "./sources/openapi.ts";
import type { BudgetState, DocSourceType, RawChunk } from "./types.ts";

export interface CascadeAttempt {
  source: DocSourceType;
  uri: string;
  status: "ok" | "not_found" | "error";
  reason?: string;
}

export interface CascadeResult {
  /** Which strategy produced the chunks (if any). */
  winning_source: DocSourceType | null;
  /** The URL that actually served content. */
  source_uri: string | null;
  /** Accumulated chunks across the winning strategy only. */
  chunks: RawChunk[];
  /** Ordered log of every probe — success, 404, or error. */
  attempts: CascadeAttempt[];
  budget_state: BudgetState;
}

export interface CascadeInput {
  /** Base URL, e.g. "https://api.example.com". Trailing slash optional. */
  base_url: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Share budget across multiple cascades on the same run. */
  state?: BudgetState;
  /** Opt-out subset — useful when a user knows the API has GraphQL only, etc. */
  allowed_sources?: DocSourceType[];
}

const DEFAULT_ORDER: DocSourceType[] = ["openapi", "graphql", "llms_txt", "markdown"];

const OPENAPI_CANDIDATE_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/v2/api-docs",
  "/v3/api-docs",
  "/api/openapi.json",
  "/api-docs",
];

const GRAPHQL_CANDIDATE_PATHS = ["/graphql", "/api/graphql", "/query"];

// Richest-first: full-content before index, root before `.well-known` mirror.
const LLMS_TXT_CANDIDATE_PATHS = [
  "/llms-full.txt",
  "/.well-known/llms-full.txt",
  "/llms.txt",
  "/.well-known/llms.txt",
];

const MARKDOWN_CANDIDATE_PATHS = [
  "/README.md",
  "/readme.md",
  "/docs.md",
  "/docs/index.md",
  "/docs/README.md",
];

// Upper bound for the raw-http fallback. If the fetched body is smaller than
// this we still treat the cascade as exhausted — a 50-byte error page is not
// useful, a 500-byte landing page probably isn't either.
const RAW_HTTP_MIN_USEFUL_BYTES = 512;

function joinUrl(base: string, path: string): string {
  // Preserve the query / port of the base; path always replaces base's path.
  const u = new URL(path, base);
  return u.toString();
}

function recordAttempt(
  attempts: CascadeAttempt[],
  source: DocSourceType,
  uri: string,
  status: CascadeAttempt["status"],
  reason?: string,
): void {
  const entry: CascadeAttempt = { source, uri, status };
  if (reason !== undefined) entry.reason = reason;
  attempts.push(entry);
}

async function tryOpenAPI(
  input: CascadeInput,
  state: BudgetState,
  attempts: CascadeAttempt[],
): Promise<RawChunk[] | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const path of OPENAPI_CANDIDATE_PATHS) {
    const uri = joinUrl(input.base_url, path);
    try {
      const res = await ingestOpenAPIUrl(uri, state, fetchImpl);
      if (res.chunks.length > 0) {
        recordAttempt(attempts, "openapi", uri, "ok");
        return res.chunks;
      }
      recordAttempt(attempts, "openapi", uri, "not_found", "empty chunks");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /\b404\b|not found/i.test(msg) ? "not_found" : "error";
      recordAttempt(attempts, "openapi", uri, status, msg);
    }
  }
  // HTML-link-extractor sub-cascade: fetch the base URL, look for obvious
  // spec links in the returned HTML body, retry. Intentionally bounded —
  // we only follow the first two candidate links.
  const discovered = await discoverOpenApiLinks(input.base_url, input.fetchImpl ?? fetch);
  for (const uri of discovered.slice(0, 2)) {
    try {
      const res = await ingestOpenAPIUrl(uri, state, input.fetchImpl ?? fetch);
      if (res.chunks.length > 0) {
        recordAttempt(attempts, "openapi", uri, "ok", "via link-extractor");
        return res.chunks;
      }
      recordAttempt(attempts, "openapi", uri, "not_found", "empty chunks (link-extractor)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordAttempt(attempts, "openapi", uri, "error", `link-extractor: ${msg}`);
    }
  }
  return null;
}

// Match strings that smell like a spec link — must contain openapi /
// swagger / api-docs AND look URL-shaped (absolute, root-relative, or
// path-with-extension). Filters out version numbers like "3.0.3" sitting
// inside a top-level `openapi` field of an already-fetched spec.
const SPEC_LINK_RE = /openapi|swagger|api-docs/i;

function looksUrlLike(value: string): boolean {
  if (value.startsWith("http://") || value.startsWith("https://")) return true;
  if (value.startsWith("/")) return true;
  // Relative path with a known doc-ish extension.
  if (/\.(json|ya?ml|html?)(\?|$)/i.test(value)) return true;
  return false;
}

/**
 * Walk a parsed JSON/YAML tree and yield every string value that smells
 * like a spec URL. Iterative DFS to avoid stack overflow on pathological
 * inputs. Bounded by `MAX_NODES` so a malicious doc can't pin the worker.
 */
function walkForSpecLinks(root: unknown): string[] {
  const MAX_NODES = 5_000;
  const out: string[] = [];
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    visited += 1;
    const node = stack.pop();
    if (typeof node === "string") {
      if (SPEC_LINK_RE.test(node) && looksUrlLike(node)) out.push(node);
      continue;
    }
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node)) stack.push(v);
    }
  }
  return out;
}

/**
 * Scan the body of a base URL for links that smell like OpenAPI / Swagger
 * specs. Tries three readers, in order:
 *   1. JSON parse — walk the tree for string values matching the pattern.
 *      Handles e.g. `{"swaggerUrl": "/spec.json"}`, ReadMe.io discovery
 *      payloads, Apigee-style listings.
 *   2. YAML parse — same walk, for YAML-shaped indices.
 *   3. HTML href regex — final fallback, the original behaviour.
 *
 * The function never throws — failure modes return `[]`. Caller is
 * responsible for trying each candidate.
 */
export async function discoverOpenApiLinks(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  let body: string;
  let contentType: string;
  try {
    const res = await fetchImpl(baseUrl, {
      headers: { accept: "application/json, application/yaml, text/yaml, text/html, */*" },
    });
    if (!res.ok) return [];
    contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    body = await res.text();
  } catch {
    return [];
  }
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (!seen.has(abs)) {
        seen.add(abs);
        candidates.push(abs);
      }
    } catch {
      // Skip malformed URLs.
    }
  };

  // 1. JSON walk.
  if (
    contentType.includes("json") ||
    body.trimStart().startsWith("{") ||
    body.trimStart().startsWith("[")
  ) {
    try {
      const parsed = JSON.parse(body);
      for (const v of walkForSpecLinks(parsed)) push(v);
    } catch {
      // not valid JSON — fall through
    }
  }

  // 2. YAML walk (when JSON parse missed it). Skip if we already found
  // candidates via JSON to avoid duplicating effort on pure JSON bodies.
  if (candidates.length === 0 && (contentType.includes("yaml") || /\.ya?ml(\?|$)/i.test(baseUrl))) {
    try {
      const parsed = loadYaml(body);
      for (const v of walkForSpecLinks(parsed)) push(v);
    } catch {
      // not valid YAML — fall through
    }
  }

  // 3. HTML href regex — covers landing pages and Swagger-UI shells.
  if (candidates.length === 0) {
    const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null = hrefRe.exec(body);
    while (m) {
      const raw = m[1];
      if (raw && SPEC_LINK_RE.test(raw)) push(raw);
      m = hrefRe.exec(body);
    }
  }

  return candidates;
}

async function tryGraphQL(
  input: CascadeInput,
  state: BudgetState,
  attempts: CascadeAttempt[],
): Promise<RawChunk[] | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const path of GRAPHQL_CANDIDATE_PATHS) {
    const uri = joinUrl(input.base_url, path);
    try {
      const res = await ingestGraphQLIntrospection(uri, state, fetchImpl);
      if (res.chunks.length > 0) {
        recordAttempt(attempts, "graphql", uri, "ok");
        return res.chunks;
      }
      recordAttempt(attempts, "graphql", uri, "not_found", "empty chunks");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /\b404\b|not found/i.test(msg) ? "not_found" : "error";
      recordAttempt(attempts, "graphql", uri, status, msg);
    }
  }
  return null;
}

async function tryLlmsTxt(
  input: CascadeInput,
  state: BudgetState,
  attempts: CascadeAttempt[],
): Promise<RawChunk[] | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const path of LLMS_TXT_CANDIDATE_PATHS) {
    const uri = joinUrl(input.base_url, path);
    try {
      const res = await ingestLlmsTxt(uri, state, fetchImpl);
      if (res.chunks.length > 0) {
        recordAttempt(attempts, "llms_txt", uri, "ok");
        return res.chunks;
      }
      recordAttempt(attempts, "llms_txt", uri, "not_found", "empty chunks");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /\b404\b|not found/i.test(msg) ? "not_found" : "error";
      recordAttempt(attempts, "llms_txt", uri, status, msg);
    }
  }
  return null;
}

async function tryMarkdown(
  input: CascadeInput,
  state: BudgetState,
  attempts: CascadeAttempt[],
): Promise<RawChunk[] | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  for (const path of MARKDOWN_CANDIDATE_PATHS) {
    const uri = joinUrl(input.base_url, path);
    try {
      const res = await ingestMarkdown({ url: uri }, state, fetchImpl);
      if (res.chunks.length > 0) {
        recordAttempt(attempts, "markdown", uri, "ok");
        return res.chunks;
      }
      recordAttempt(attempts, "markdown", uri, "not_found", "empty chunks");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /\b404\b|not found/i.test(msg) ? "not_found" : "error";
      recordAttempt(attempts, "markdown", uri, status, msg);
    }
  }
  return null;
}

async function tryRawHttp(
  input: CascadeInput,
  state: BudgetState,
  attempts: CascadeAttempt[],
): Promise<{ chunks: RawChunk[]; uri: string } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const uri = input.base_url;
  try {
    const res = await fetchImpl(uri, {
      headers: { accept: "text/plain,text/markdown,text/html,*/*" },
    });
    if (!res.ok) {
      recordAttempt(attempts, "markdown", uri, "error", `raw-http fetch ${res.status}`);
      return null;
    }
    const body = await res.text();
    const bytes = byteLen(body);
    if (bytes < RAW_HTTP_MIN_USEFUL_BYTES) {
      recordAttempt(
        attempts,
        "markdown",
        uri,
        "not_found",
        `raw-http body ${bytes}B < ${RAW_HTTP_MIN_USEFUL_BYTES}B threshold`,
      );
      return null;
    }
    if (!canConsumeBytes(state, bytes)) {
      markBudgetExceeded(state);
      recordAttempt(attempts, "markdown", uri, "error", "budget exceeded before raw-http chunk");
      return null;
    }
    consumeBytes(state, bytes);
    recordAttempt(attempts, "markdown", uri, "ok", "raw-http fallback");
    return {
      uri,
      chunks: [
        {
          title: "raw-http fallback",
          path: "raw",
          content: body,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordAttempt(attempts, "markdown", uri, "error", `raw-http: ${msg}`);
    return null;
  }
}

/**
 * Attempt each strategy in order. Returns the first non-empty chunk set.
 *
 * The caller gets a full audit trail via `attempts` even when something
 * succeeds — operators want to see that /openapi.json 404'd before the
 * cascade fell through to GraphQL, so freshness dashboards have context.
 */
export async function cascadeIngest(input: CascadeInput): Promise<CascadeResult> {
  const state = input.state ?? createBudgetState();
  const attempts: CascadeAttempt[] = [];
  const order = (input.allowed_sources ?? DEFAULT_ORDER).filter((s) => DEFAULT_ORDER.includes(s));

  for (const source of order) {
    let chunks: RawChunk[] | null = null;
    let winning_uri: string | null = null;
    switch (source) {
      case "openapi":
        chunks = await tryOpenAPI(input, state, attempts);
        winning_uri = chunks
          ? (attempts.findLast((a) => a.source === "openapi" && a.status === "ok")?.uri ?? null)
          : null;
        break;
      case "graphql":
        chunks = await tryGraphQL(input, state, attempts);
        winning_uri = chunks
          ? (attempts.findLast((a) => a.source === "graphql" && a.status === "ok")?.uri ?? null)
          : null;
        break;
      case "llms_txt":
        chunks = await tryLlmsTxt(input, state, attempts);
        winning_uri = chunks
          ? (attempts.findLast((a) => a.source === "llms_txt" && a.status === "ok")?.uri ?? null)
          : null;
        break;
      case "markdown":
        chunks = await tryMarkdown(input, state, attempts);
        winning_uri = chunks
          ? (attempts.findLast((a) => a.source === "markdown" && a.status === "ok")?.uri ?? null)
          : null;
        break;
      default:
        // html/postgres/file_upload are not part of the URL-based cascade.
        break;
    }
    if (chunks && chunks.length > 0) {
      return {
        winning_source: source,
        source_uri: winning_uri,
        chunks,
        attempts,
        budget_state: state,
      };
    }
  }

  // Last-ditch: fetch base_url and shove the body in as a single chunk.
  const raw = await tryRawHttp(input, state, attempts);
  if (raw) {
    return {
      winning_source: "markdown",
      source_uri: raw.uri,
      chunks: raw.chunks,
      attempts,
      budget_state: state,
    };
  }

  return {
    winning_source: null,
    source_uri: null,
    chunks: [],
    attempts,
    budget_state: state,
  };
}
