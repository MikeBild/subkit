import { logger } from "../../logging/logger.ts";
import { getDriverFetch } from "../drivers/fetch-seam.ts";
import { scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import type { ConnectorSelfDescriptionLink } from "../types.ts";
import { looksLikeGraphQLUrl } from "./graphql-introspect.ts";
import { WELL_KNOWN_PATHS } from "./html-scrape.ts";
import { CANDIDATE_PATHS } from "./llms-txt.ts";

const PROBE_TIMEOUT_MS = 8_000;

const MAX_PROBE_BYTES = 64 * 1024;

const MIN_PLAUSIBLE_BYTES = 40;

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

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

async function readCapped(res: Response): Promise<string | null> {
  try {
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_PROBE_BYTES ? buf.slice(0, MAX_PROBE_BYTES) : buf;
    return new TextDecoder().decode(slice);
  } catch {
    return null;
  }
}

function looksLikeOpenAPISpec(text: string): boolean {
  if (text.length < MIN_PLAUSIBLE_BYTES) return false;
  if (/"openapi"\s*:/.test(text)) return true;
  if (/"swagger"\s*:/.test(text)) return true;
  if (/^openapi\s*:/m.test(text)) return true;
  if (/^swagger\s*:/m.test(text)) return true;
  return false;
}

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

async function probeGraphQL(
  baseUrl: string,
  origin: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
  now: string,
): Promise<ConnectorSelfDescriptionLink | null> {
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
    if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
      return { kind: "graphql", url, source: "self_healing", discovered_at: now };
    }
  }
  return null;
}

export async function probeAllSelfDescriptionLinks(
  baseUrl: string,
  opts: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
): Promise<ConnectorSelfDescriptionLink[]> {
  const origin = originOf(baseUrl);
  if (!origin) return [];

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
