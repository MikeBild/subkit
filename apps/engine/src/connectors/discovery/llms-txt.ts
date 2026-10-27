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

export const CANDIDATE_PATHS: { path: string; preferred: boolean }[] = [
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

function parseUrlsFromIndex(content: string, sourceUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const target =
      line.match(/\[[^\]]+\]\(([^)\s]+)\)/)?.[1] ?? line.match(/^(https?:\/\/\S+)\s*$/)?.[1];
    if (!target) continue;
    try {
      const resolved = new URL(target, sourceUrl);
      if (
        !["https:", "http:"].includes(resolved.protocol) ||
        resolved.username ||
        resolved.password
      )
        continue;
      resolved.hash = "";
      const url = resolved.href;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    } catch {}
  }
  return urls;
}

function looksLikeIndex(content: string): boolean {
  const nonEmpty = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (nonEmpty.length === 0) return false;
  const urlLines = nonEmpty.filter(
    (l) => /^https?:\/\//.test(l) || /\[[^\]]+\]\([^)\s]+\)/.test(l),
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
    const res = await getDriverFetch()(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) {
        await reader.cancel();
        break;
      }
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
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

    const serviceBase = new URL(baseUrl);
    serviceBase.search = "";
    serviceBase.hash = "";
    const bases = [...new Set([serviceBase.href.replace(/\/$/, ""), origin])];
    const candidates = bases.flatMap((base) => CANDIDATE_PATHS.map(({ path }) => `${base}${path}`));
    for (const candidate of candidates) {
      const body = await fetchText(candidate, opts);
      if (!body) continue;
      const trimmed = body.trim();
      if (trimmed.length < MIN_FULL_BODY_CHARS && !looksLikeIndex(trimmed)) {
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
      const urls = parseUrlsFromIndex(chosenBody, chosenUrl).slice(0, MAX_INDEX_FANOUT);
      const { headers: _headers, ...requestOptions } = opts;
      const fetched = await Promise.all(
        urls.map((u) =>
          fetchText(u, {
            ...requestOptions,
            headers: new URL(u).origin === origin ? { ...(opts.headers ?? {}) } : {},
          }),
        ),
      );
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
