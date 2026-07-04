// Self-description link probe.
//
// Probes ALL known self-description surfaces for a connector base URL
// INDEPENDENTLY (never stopping at the first hit), and returns every link
// found. This complements the interactive discovery chain
// (`discoverConnectorEndpoints`) which is single-winner by design.
//
// Surfaces probed concurrently:
//   1. OpenAPI — well-known spec paths from html-scrape.ts (same list the
//      html-scrape strategy walks). Records a "openapi" link for the first
//      path that returns 200 + plausible spec content.
//   2. llms.txt — candidate paths from llms-txt.ts (richest-first). Records
//      a "llms_full" link for *-full.txt variants, "llms_txt" otherwise.
//   3. GraphQL — cheap `{ __typename }` probe at /graphql (and the base URL
//      itself when it looks like a GraphQL endpoint). Records a "graphql" link
//      on confirmation.
//
// LINKS ONLY — never document bodies. No persistence, no docs ingestion, no
// DB writes. Callers own persistence.
//
// Egress discipline mirrors llms-txt.ts: assertEgressAllowed + getDriverFetch,
// per-fetch 8s AbortController timeout, small response cap. Non-fatal per
// surface: a 404 / timeout / egress-block on one surface must not abort the
// others. Returns [] on bad origin or egress-blocked base URL.

import { logger } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import type { ConnectorSelfDescriptionLink } from "../types.ts";
import { looksLikeGraphQLUrl } from "./graphql-introspect.ts";
import { WELL_KNOWN_PATHS } from "./html-scrape.ts";
import { CANDIDATE_PATHS } from "./llms-txt.ts";

/** Per-fetch network budget. */
const PROBE_TIMEOUT_MS = 8_000;

/** Response cap for plausibility reads — we only need enough bytes to
 *  identify the format, not the full document body. */
const MAX_PROBE_BYTES = 64 * 1024;

/** Minimum body length to count as "plausible content" (avoids treating a
 *  204 No Content or a tiny error HTML as a valid match). */
const MIN_PLAUSIBLE_BYTES = 40;

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with an independent 8s timeout and the outer signal wired in.
 * Non-fatal: catches all transport errors and returns `null`. The caller
 * must check the response status independently.
 */
async function safeFetch(
  url: string,
  init: Omit<RequestInit, "signal">,
  outerSignal: AbortSignal | undefined,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer);
      return null;
    }
    outerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await getDriverFetch()(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read up to MAX_PROBE_BYTES from a Response body. Returns null when the
 * body cannot be decoded (network error after headers).
 */
async function readCapped(res: Response): Promise<string | null> {
  try {
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_PROBE_BYTES ? buf.slice(0, MAX_PROBE_BYTES) : buf;
    return new TextDecoder().decode(slice);
  } catch {
    return null;
  }
}

/**
 * True when the text looks plausibly like an OpenAPI / Swagger document
 * (JSON object or YAML mapping that carries the discriminator key).
 */
function looksLikeOpenAPISpec(text: string): boolean {
  if (text.length < MIN_PLAUSIBLE_BYTES) return false;
  // JSON form: "openapi": "3.x" or "swagger": "2.x"
  if (/"openapi"\s*:/.test(text)) return true;
  if (/"swagger"\s*:/.test(text)) return true;
  // YAML form: openapi: or swagger: at the start of a line
  if (/^openapi\s*:/m.test(text)) return true;
  if (/^swagger\s*:/m.test(text)) return true;
  return false;
}

/**
 * Probe the OpenAPI well-known paths under `origin`. Returns the FIRST
 * path that responds 200 + looks like a spec. Non-fatal (catches per-URL
 * egress blocks; callers catch the whole thing).
 */
async function probeOpenAPI(
  origin: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
  now: string,
): Promise<ConnectorSelfDescriptionLink | null> {
  for (const path of WELL_KNOWN_PATHS) {
    const url = `${origin}${path}`;
    try {
      assertEgressAllowed(url, {});
    } catch {
      // This specific URL is egress-blocked (e.g. private range); skip it
      // and continue to the next candidate.
      continue;
    }
    const res = await safeFetch(
      url,
      { method: "GET", headers: { accept: "application/json, application/yaml, */*", ...headers } },
      signal,
    );
    if (!res?.ok) continue;
    const text = await readCapped(res);
    if (!text || !looksLikeOpenAPISpec(text)) continue;
    return { kind: "openapi", url, source: "self_healing", discovered_at: now };
  }
  return null;
}

/**
 * Probe the llms.txt candidate paths under `origin`. Probed richest-first
 * (same order as CANDIDATE_PATHS: llms-full.txt before llms.txt). Returns
 * the richest link found, or null.
 */
async function probeLlms(
  origin: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
  now: string,
): Promise<ConnectorSelfDescriptionLink | null> {
  for (const { path } of CANDIDATE_PATHS) {
    const url = `${origin}${path}`;
    try {
      assertEgressAllowed(url, {});
    } catch {
      continue;
    }
    const res = await safeFetch(
      url,
      { method: "GET", headers: { accept: "text/plain, text/markdown, */*", ...headers } },
      signal,
    );
    if (!res?.ok) continue;
    const text = await readCapped(res);
    if (!text || text.trim().length < MIN_PLAUSIBLE_BYTES) continue;
    const kind: ConnectorSelfDescriptionLink["kind"] = path.includes("llms-full.txt")
      ? "llms_full"
      : "llms_txt";
    return { kind, url, source: "self_healing", discovered_at: now };
  }
  return null;
}

/**
 * Probe for a GraphQL endpoint. Sends a cheap `{ __typename }` POST. Tries
 * the base URL first if it looks like a GraphQL URL, then `/graphql` under
 * the origin. Returns a link on confirmation (JSON response with `data`
 * containing `__typename`), null otherwise.
 */
async function probeGraphQL(
  baseUrl: string,
  origin: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
  now: string,
): Promise<ConnectorSelfDescriptionLink | null> {
  // Build candidate list: base URL first when it already looks like a
  // GraphQL endpoint, then the conventional /graphql path.
  const candidates: string[] = [];
  if (looksLikeGraphQLUrl(baseUrl)) candidates.push(baseUrl);
  const conventionalUrl = `${origin}/graphql`;
  if (!candidates.includes(conventionalUrl)) candidates.push(conventionalUrl);

  for (const url of candidates) {
    try {
      assertEgressAllowed(url, {});
    } catch {
      continue;
    }
    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify({ query: "{ __typename }" }),
      },
      signal,
    );
    if (!res?.ok) continue;
    const text = await readCapped(res);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    // Confirmation: the response JSON has a "data" key (GraphQL envelope).
    if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
      return { kind: "graphql", url, source: "self_healing", discovered_at: now };
    }
  }
  return null;
}

/**
 * Probe every known self-description surface for `baseUrl` independently and
 * return all link kinds found.
 *
 * Each surface (OpenAPI, llms.txt, GraphQL) runs concurrently and is
 * non-fatal: a 404, timeout, or egress block on one does not abort the
 * others. Returns [] when the origin cannot be derived, when the origin is
 * egress-blocked, or when no surface responds.
 *
 * LINKS ONLY — never document bodies. No DB writes, no docs ingestion.
 */
export async function probeAllSelfDescriptionLinks(
  baseUrl: string,
  opts: {
    /** Unused by the implementation (egress goes through getDriverFetch).
     *  Included for interface parity with the cascade.ts injection pattern. */
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
): Promise<ConnectorSelfDescriptionLink[]> {
  const origin = originOf(baseUrl);
  if (!origin) return [];

  // Guard the origin once up-front. If the host itself is on the blocklist
  // (private range, loopback, link-local) there is no point fanning out.
  try {
    assertEgressAllowed(origin, {});
  } catch {
    logger.warn({
      module: "connector",
      action: "discovery.probe.egress_blocked",
      url: scrubUrl(baseUrl),
    });
    return [];
  }

  const signal = opts.signal;
  const headers = opts.headers ?? {};
  const now = new Date().toISOString();

  // Run all three probes concurrently. Per-probe errors are caught and
  // logged at debug level so one bad surface never aborts the others.
  const [openapiLink, llmsLink, graphqlLink] = await Promise.all([
    probeOpenAPI(origin, signal, headers, now).catch((err) => {
      logger.debug({
        module: "connector",
        action: "discovery.probe.openapi_error",
        url: scrubUrl(baseUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    probeLlms(origin, signal, headers, now).catch((err) => {
      logger.debug({
        module: "connector",
        action: "discovery.probe.llms_error",
        url: scrubUrl(baseUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    probeGraphQL(baseUrl, origin, signal, headers, now).catch((err) => {
      logger.debug({
        module: "connector",
        action: "discovery.probe.graphql_error",
        url: scrubUrl(baseUrl),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
  ]);

  const links: ConnectorSelfDescriptionLink[] = [];
  if (openapiLink) links.push(openapiLink);
  if (llmsLink) links.push(llmsLink);
  if (graphqlLink) links.push(graphqlLink);

  logger.debug({
    module: "connector",
    action: "discovery.probe.complete",
    url: scrubUrl(baseUrl),
    kinds_found: links.map((l) => l.kind),
  });

  return links;
}
