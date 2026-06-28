// Strategy: `llms.txt` / `llms-full.txt` fallback.
//
// The llms-txt standard (<https://llmstxt.org>) lets a service publish a
// plaintext / markdown document at `/llms-full.txt` (full content) or
// `/llms.txt` (an index of links) describing the surface in LLM-friendly
// prose. The spec's canonical location is the site root; some sites mirror
// it under `/.well-known/` too, so we probe both — root first, full-content
// variant first. For services that don't ship OpenAPI or GraphQL
// introspection — but DO publish llms.txt — this strategy is the zero-cost
// win.
//
// Output shape: a `DiscoveryResult` with `endpoints: []` and a populated
// `text_corpus`. Downstream consumers feed `text_corpus` into RAG /
// chunking; they do not iterate `endpoints` for this strategy.
//
// Size cap: merged corpus is truncated at 50 KB to keep prompt budgets
// in check. Fan-out cap: max 10 sub-pages when llms.txt is an index.

import { log } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CORPUS_BYTES = 50 * 1024;
const MAX_SINGLE_DOC_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_FANOUT = 10;
const MIN_FULL_BODY_CHARS = 200;

// Probed richest-first: full-content before index, root before `.well-known`.
// Root is the llms-txt spec's canonical location; `.well-known` is a common
// mirror, so we try both rather than assume one.
const CANDIDATE_PATHS: { path: string; preferred: boolean }[] = [
  { path: "/llms-full.txt", preferred: true },
  { path: "/.well-known/llms-full.txt", preferred: true },
  { path: "/llms.txt", preferred: false },
  { path: "/.well-known/llms.txt", preferred: false },
];

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function parseUrlsFromIndex(content: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // Markdown link form: `[label](https://example.com/...)`.
    const md = line.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/);
    if (md?.[1]) {
      if (!seen.has(md[1])) {
        seen.add(md[1]);
        urls.push(md[1]);
      }
      continue;
    }
    // Bare URL line.
    const bare = line.match(/^(https?:\/\/\S+)\s*$/);
    if (bare?.[1]) {
      if (!seen.has(bare[1])) {
        seen.add(bare[1]);
        urls.push(bare[1]);
      }
    }
  }
  return urls;
}

/**
 * Heuristic: a body is "index-shaped" when most of its non-empty lines
 * carry a URL. A body is "content-shaped" when it has markdown headings
 * or paragraphs and few standalone URLs. Used to decide whether to fan
 * out and fetch sub-pages or use the body as-is.
 */
function looksLikeIndex(content: string): boolean {
  const nonEmpty = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (nonEmpty.length === 0) return false;
  const urlLines = nonEmpty.filter(
    (l) => /^https?:\/\//.test(l) || /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/.test(l),
  );
  return urlLines.length / nonEmpty.length >= 0.5;
}

async function fetchText(
  url: string,
  opts: DiscoveryStrategyOptions,
  maxBytes = MAX_SINGLE_DOC_BYTES,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const headers: Record<string, string> = {
      accept: "text/plain, text/markdown, */*",
      ...(opts.headers ?? {}),
    };
    assertEgressAllowed(url, {});
    const res = await getDriverFetch()(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      // Truncate rather than reject — these docs can legitimately be big.
      return new TextDecoder().decode(buf.slice(0, maxBytes));
    }
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clipCorpus(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MAX_CORPUS_BYTES) return text;
  return buf.subarray(0, MAX_CORPUS_BYTES).toString("utf8");
}

class LlmsTxtStrategy implements DiscoveryStrategy {
  readonly name = "llms-txt" as const;

  canHandle(_url: string): boolean {
    return true;
  }

  async fetch(baseUrl: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(baseUrl),
    });

    const origin = originOf(baseUrl);
    if (!origin) {
      const failure = new DiscoveryError(
        "spec_not_found",
        `cannot derive origin from ${scrubUrl(baseUrl)}`,
      );
      log.debug({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(baseUrl),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }

    let chosenUrl: string | null = null;
    let chosenBody: string | null = null;

    for (const { path } of CANDIDATE_PATHS) {
      const candidate = `${origin}${path}`;
      const body = await fetchText(candidate, opts);
      if (!body) continue;
      const trimmed = body.trim();
      if (trimmed.length < MIN_FULL_BODY_CHARS && !looksLikeIndex(trimmed)) {
        // Too small to be meaningful AND not a list of URLs — skip.
        continue;
      }
      chosenUrl = candidate;
      chosenBody = trimmed;
      break;
    }

    if (!chosenUrl || !chosenBody) {
      const failure = new DiscoveryError(
        "spec_not_found",
        `no llms.txt found at the standard paths under ${scrubUrl(origin)}`,
      );
      log.debug({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(baseUrl),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }

    let corpus: string;
    let mode: "full" | "index";
    if (looksLikeIndex(chosenBody)) {
      mode = "index";
      const urls = parseUrlsFromIndex(chosenBody).slice(0, MAX_INDEX_FANOUT);
      const fetched = await Promise.all(urls.map((u) => fetchText(u, opts)));
      const parts: string[] = [];
      for (let i = 0; i < urls.length; i++) {
        const body = fetched[i];
        if (typeof body !== "string") continue;
        const trimmed = body.trim();
        if (!trimmed) continue;
        parts.push(`<!-- Source: ${urls[i]} -->\n${trimmed}`);
      }
      corpus = clipCorpus(parts.join("\n\n"));
    } else {
      mode = "full";
      corpus = clipCorpus(chosenBody);
    }

    if (!corpus) {
      const failure = new DiscoveryError(
        "spec_not_found",
        `llms.txt at ${scrubUrl(chosenUrl)} produced an empty corpus`,
      );
      log.debug({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(baseUrl),
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }

    log.info({
      module: "connector",
      action: "discovery.strategy.succeeded",
      strategy: this.name,
      url: scrubUrl(baseUrl),
      matched: scrubUrl(chosenUrl),
      mode,
      corpus_bytes: Buffer.byteLength(corpus, "utf8"),
    });

    return {
      source_url: chosenUrl,
      fetched_at: new Date().toISOString(),
      strategy: this.name,
      spec_version: null,
      title: null,
      servers: [origin],
      auth_schemes: [],
      endpoints: [],
      warnings: [],
      text_corpus: corpus,
    };
  }
}

export const llmsTxtStrategy: DiscoveryStrategy = new LlmsTxtStrategy();
