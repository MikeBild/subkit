import type { DiscoveredEndpoint, DiscoveryResult } from "../connectors/discovery/types.ts";

export const DISCOVERED_ENDPOINTS_PER_CONNECTOR = 40;

export function selectDiscoveredEndpoints(
  endpoints: ReadonlyArray<DiscoveredEndpoint>,
  goal: string,
  limit: number,
  pinned: ReadonlyArray<DiscoveredEndpoint> = [],
): DiscoveredEndpoint[] {
  const tokens = new Set(goal.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const pinnedSet = new Set(pinned);
  const head = endpoints.filter((endpoint) => pinnedSet.has(endpoint));
  const ranked = endpoints
    .map((endpoint, index) => {
      const description =
        `${endpoint.path} ${endpoint.summary ?? ""} ${endpoint.description ?? ""}`.toLowerCase();
      const relevance = [...tokens].filter((token) => description.includes(token)).length;
      return { endpoint, index, relevance };
    })
    .filter(({ endpoint }) => !pinnedSet.has(endpoint))
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .map(({ endpoint }) => endpoint);
  return [...head, ...ranked].slice(0, Math.max(limit, head.length));
}

export function formatDiscoveredEndpoints(
  connectors: ReadonlyArray<{ id: string; slug: string; base_url: string | null }>,
  discoveredById: ReadonlyMap<string, DiscoveryResult>,
  goal: string,
  regrounding?: {
    pins: ReadonlyMap<string, DiscoveredEndpoint[]>;
    caps: ReadonlyMap<string, number>;
  },
): string | null {
  const blocks: string[] = [];
  for (const c of connectors) {
    const index = discoveredById.get(c.id);
    if (!index || index.endpoints.length === 0) continue;
    const cap = regrounding?.caps.get(c.id) ?? DISCOVERED_ENDPOINTS_PER_CONNECTOR;
    const selected = selectDiscoveredEndpoints(
      index.endpoints,
      goal,
      cap,
      regrounding?.pins.get(c.id) ?? [],
    );
    const lines = selected.map((e) => {
      const ct = e.request_content_type ? ` [${e.request_content_type}]` : "";
      const summary = e.summary ? ` — ${e.summary}` : "";
      return `- ${e.method} ${e.path}${ct}${summary}`;
    });
    if (index.endpoints.length > selected.length) {
      lines.push(
        `- …and ${index.endpoints.length - selected.length} documented routes are omitted from this goal-ranked excerpt. No discovery tool is available in this generation call. If the supplied routes cannot satisfy the goal, call abort and list each missing operation in \`needs\` (kind endpoint_contract with connector_slug, method and path) so the engine can look it up.`,
      );
    }
    blocks.push(`### \`${c.slug}\` (base_url ${c.base_url ?? "(none)"})`, ...lines);
  }
  if (blocks.length === 0) return null;
  return [
    "## Discovered endpoints — authoritative source of truth",
    "The connector(s) below publish a machine-readable spec. These listed routes are documented, but the excerpt may omit other routes. Bind every request step to an exact grounded `method` + `path` pair — do NOT invent, guess, drop a version prefix, or REST-ify routes (e.g. never turn `/v1/sites/{site}/content` into `/sites/{site}/items`). When an endpoint declares a request media type in `[brackets]`, encode the body that way — for `text/markdown` send the raw markdown string as the body, NOT a JSON object wrapping it.",
    ...blocks,
  ].join("\n");
}
