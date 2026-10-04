export interface ConnectorOverlapInput {
  driver: string;
  base_url: string | null;
  auth_type: string;
}

export interface ConnectorOverlapMatch<Existing extends { id: string }> {
  connector: Existing;
  score: 0 | 1 | 2 | 3;
  dimensions: ReadonlyArray<"driver" | "base_url_host" | "auth_type">;
}

export function baseUrlHost(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

export function scoreConnectorOverlap<Existing extends ConnectorOverlapInput & { id: string }>(
  existing: Existing,
  proposed: ConnectorOverlapInput,
): ConnectorOverlapMatch<Existing> {
  const dimensions: Array<"driver" | "base_url_host" | "auth_type"> = [];
  if (existing.driver === proposed.driver) dimensions.push("driver");
  const existingHost = baseUrlHost(existing.base_url);
  const proposedHost = baseUrlHost(proposed.base_url);
  if (existingHost && existingHost === proposedHost) dimensions.push("base_url_host");
  if (existing.auth_type === proposed.auth_type) dimensions.push("auth_type");
  return {
    connector: existing,
    score: dimensions.length as 0 | 1 | 2 | 3,
    dimensions,
  };
}

export function compareConnectorOverlap<Existing extends ConnectorOverlapInput & { id: string }>(
  existing: ReadonlyArray<Existing>,
  proposed: ConnectorOverlapInput,
  options: { minScore?: 1 | 2 | 3 } = {},
): ConnectorOverlapMatch<Existing>[] {
  const threshold = options.minScore ?? 2;
  const matches = existing.map((c) => scoreConnectorOverlap(c, proposed));
  return matches
    .filter(
      (m): m is ConnectorOverlapMatch<Existing> & { score: 1 | 2 | 3 } => m.score >= threshold,
    )
    .sort((a, b) => b.score - a.score);
}
