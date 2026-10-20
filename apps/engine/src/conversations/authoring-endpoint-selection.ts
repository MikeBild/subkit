import type { DiscoveredEndpoint } from "../connectors/discovery/types.ts";

export function selectDiscoveredEndpoints(
  endpoints: ReadonlyArray<DiscoveredEndpoint>,
  goal: string,
  limit: number,
): DiscoveredEndpoint[] {
  const tokens = new Set(goal.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return endpoints
    .map((endpoint, index) => {
      const description =
        `${endpoint.path} ${endpoint.summary ?? ""} ${endpoint.description ?? ""}`.toLowerCase();
      const relevance = [...tokens].filter((token) => description.includes(token)).length;
      return { endpoint, index, relevance };
    })
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, limit)
    .map(({ endpoint }) => endpoint);
}
