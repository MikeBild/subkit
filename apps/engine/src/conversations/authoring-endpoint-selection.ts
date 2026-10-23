import type { DiscoveredEndpoint } from "../connectors/discovery/types.ts";

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
