import { suggestClosest } from "../workflows/levenshtein.ts";

export interface DiscoveredConnectorEndpoints {
  slug: string;
  base_url: string | null;
  endpoints: ReadonlyArray<{
    method: string;
    path: string;
    request_content_type: string | null;
  }>;
}

interface DiscoveryIndexLike {
  endpoints: ReadonlyArray<{
    method: string;
    path: string;
    request_content_type: string | null;
  }>;
}

export function buildGroundingIndex(
  connectors: ReadonlyArray<{ id: string; slug: string; base_url: string | null }>,
  discoveredById: ReadonlyMap<string, DiscoveryIndexLike>,
): Map<string, DiscoveredConnectorEndpoints> {
  const index = new Map<string, DiscoveredConnectorEndpoints>();
  for (const c of connectors) {
    const discovered = discoveredById.get(c.id);
    if (!discovered) continue;
    const projected: DiscoveredConnectorEndpoints = {
      slug: c.slug,
      base_url: c.base_url,
      endpoints: discovered.endpoints.map((e) => ({
        method: e.method,
        path: e.path,
        request_content_type: e.request_content_type,
      })),
    };
    index.set(c.id, projected);
    index.set(c.slug, projected);
  }
  return index;
}

interface EndpointGroundingBlock {
  step_id: string;
  connector_slug: string;
  method: string;
  path: string;
  reason: "path_not_in_discovered_spec" | "content_type_mismatch";
  nearest: string[];
}

interface EndpointGroundingResult {
  ok: boolean;
  blocks: EndpointGroundingBlock[];
}

export function describeEndpointGroundingBlock(b: EndpointGroundingBlock): string {
  if (b.reason === "content_type_mismatch") {
    return `request \`${b.step_id}\` sends a JSON object body to \`${b.method} ${b.path}\`, but \`${b.connector_slug}\` declares this endpoint as \`${b.nearest[0]}\` — encode the body as that media type (e.g. a raw string), not a JSON object`;
  }
  const hint =
    b.nearest.length > 0
      ? ` Did you mean: ${b.nearest.join(", ")}?`
      : " Re-check the connector's discovered endpoints (discover_connector_endpoints).";
  return `request \`${b.step_id}\` targets \`${b.method} ${b.path}\` — not a documented endpoint of \`${b.connector_slug}\`.${hint}`;
}

export function normalizeRequestPath(rawTarget: string, base_url: string | null): string {
  let s = rawTarget.trim();
  s = s.replace(/^\$\{\s*connector\.[a-zA-Z0-9_-]+\.(?:base_url|url)\s*\}/, "");
  if (base_url && s.startsWith(base_url)) s = s.slice(base_url.length);
  const abs = /^https?:\/\/[^/]+/i;
  if (abs.test(s)) s = s.replace(abs, "");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.trim();
  if (s === "") return "/";
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

function splitSegments(path: string): string[] {
  return path.split("/").filter((seg) => seg.length > 0);
}

function isTemplateSegment(seg: string): boolean {
  return (seg.startsWith("{") && seg.endsWith("}")) || seg.startsWith(":");
}

function isPlaceholderSegment(seg: string): boolean {
  return seg.includes("${") && seg.includes("}");
}

export function pathMatchesTemplate(actualPath: string, templatePath: string): boolean {
  const a = splitSegments(actualPath);
  const t = splitSegments(templatePath);
  if (a.length !== t.length) return false;
  for (let i = 0; i < a.length; i++) {
    const as = a[i] as string;
    const ts = t[i] as string;
    if (isTemplateSegment(ts)) continue;
    if (isPlaceholderSegment(as)) continue;
    if (as !== ts) return false;
  }
  return true;
}

interface RequestLike {
  id: string;
  kind: "request";
  connector_id?: unknown;
  method?: unknown;
  path?: unknown;
  url?: unknown;
  body?: unknown;
  headers?: unknown;
}

function isRequestStep(step: unknown): step is RequestLike {
  return (
    typeof step === "object" &&
    step !== null &&
    (step as { kind?: unknown }).kind === "request" &&
    typeof (step as { id?: unknown }).id === "string"
  );
}

function resolveConnectorKey(step: RequestLike): string | null {
  if (typeof step.connector_id === "string" && step.connector_id) return step.connector_id;
  const target =
    typeof step.url === "string" ? step.url : typeof step.path === "string" ? step.path : "";
  const m = /\$\{\s*connector\.([a-zA-Z0-9_-]+)\./.exec(target);
  return m ? (m[1] as string) : null;
}

function hasExplicitContentType(headers: unknown): boolean {
  if (typeof headers !== "object" || headers === null) return false;
  return Object.keys(headers as Record<string, unknown>).some(
    (k) => k.toLowerCase() === "content-type",
  );
}

export function evaluateEndpointGrounding(
  steps: ReadonlyArray<Record<string, unknown>>,
  index: ReadonlyMap<string, DiscoveredConnectorEndpoints>,
): EndpointGroundingResult {
  const blocks: EndpointGroundingBlock[] = [];

  for (const step of steps) {
    if (!isRequestStep(step)) continue;
    const key = resolveConnectorKey(step);
    if (!key) continue;
    const discovered = index.get(key);
    if (!discovered || discovered.endpoints.length === 0) continue;

    const method = (typeof step.method === "string" ? step.method : "GET").toUpperCase();
    const rawTarget =
      typeof step.path === "string" && step.path
        ? step.path
        : typeof step.url === "string"
          ? step.url
          : "";
    if (!rawTarget) continue;
    const path = normalizeRequestPath(rawTarget, discovered.base_url);

    const sameMethod = discovered.endpoints.filter((e) => e.method.toUpperCase() === method);
    const match = sameMethod.find((e) => pathMatchesTemplate(path, e.path));

    if (!match) {
      const sameMethodPaths = sameMethod.map((e) => e.path);
      const nearestPaths =
        suggestClosest(path, sameMethodPaths, 3).length > 0
          ? suggestClosest(path, sameMethodPaths, 3).map((p) => `${method} ${p}`)
          : suggestClosest(
              path,
              discovered.endpoints.map((e) => e.path),
              3,
            ).map((p) => {
              const e = discovered.endpoints.find((x) => x.path === p);
              return `${e?.method ?? method} ${p}`;
            });
      blocks.push({
        step_id: step.id,
        connector_slug: discovered.slug,
        method,
        path,
        reason: "path_not_in_discovered_spec",
        nearest: nearestPaths,
      });
      continue;
    }

    const declared = match.request_content_type;
    const bodyIsObject = typeof step.body === "object" && step.body !== null;
    if (
      declared &&
      !declared.includes("json") &&
      bodyIsObject &&
      !hasExplicitContentType(step.headers)
    ) {
      blocks.push({
        step_id: step.id,
        connector_slug: discovered.slug,
        method,
        path,
        reason: "content_type_mismatch",
        nearest: [declared],
      });
    }
  }

  return { ok: blocks.length === 0, blocks };
}
