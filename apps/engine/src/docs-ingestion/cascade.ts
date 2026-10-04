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
  winning_source: DocSourceType | null;
  source_uri: string | null;
  chunks: RawChunk[];
  attempts: CascadeAttempt[];
  budget_state: BudgetState;
}

export interface CascadeInput {
  base_url: string;
  fetchImpl?: typeof fetch;
  state?: BudgetState;
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

const RAW_HTTP_MIN_USEFUL_BYTES = 512;

function joinUrl(base: string, path: string): string {
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

const SPEC_LINK_RE = /openapi|swagger|api-docs/i;

function looksUrlLike(value: string): boolean {
  if (value.startsWith("http://") || value.startsWith("https://")) return true;
  if (value.startsWith("/")) return true;
  if (/\.(json|ya?ml|html?)(\?|$)/i.test(value)) return true;
  return false;
}

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
    } catch {}
  };

  if (
    contentType.includes("json") ||
    body.trimStart().startsWith("{") ||
    body.trimStart().startsWith("[")
  ) {
    try {
      const parsed = JSON.parse(body);
      for (const v of walkForSpecLinks(parsed)) push(v);
    } catch {}
  }

  if (candidates.length === 0 && (contentType.includes("yaml") || /\.ya?ml(\?|$)/i.test(baseUrl))) {
    try {
      const parsed = loadYaml(body);
      for (const v of walkForSpecLinks(parsed)) push(v);
    } catch {}
  }

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
