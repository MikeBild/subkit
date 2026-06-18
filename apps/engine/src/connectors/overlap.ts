// Connector-overlap scoring. Given a list of existing connectors on
// the tenant and a "proposed" connector (driver / base_url /
// auth_type that the LLM is about to draft), return a structural
// score indicating how strongly the existing connector duplicates
// the proposed one.
//
// Session 0498925e nearly created a redundant Confluence connector
// when an existing Jira connector on the same Atlassian-Cloud host
// already had the right basic-auth credential. The engine caught it
// reactively after the LLM had already proposed a draft. This
// scorer lets `match_connector_template_by_url` flag the overlap
// inline so the LLM proposes reuse on the first turn.
//
// The score is intentionally structural — no string-similarity, no
// LLM call. Three dimensions:
//   - driver           (must match exactly)
//   - base_url host    (must match exactly, after normalisation)
//   - auth_type        (must match exactly)
// All three matching = score 3 = "strong reuse candidate".
// Driver + host but different auth = score 2 = "credential conflict".
// Driver only = score 1 = "weak reuse candidate".

export interface ConnectorOverlapInput {
  /** Driver slug (e.g. "http", "graphql", "postgres"). */
  driver: string;
  /** Base URL string (e.g. "https://acme.atlassian.net"). */
  base_url: string | null;
  /** Credential mode (e.g. "basic", "oauth2_authorization_code"). */
  auth_type: string;
}

export interface ConnectorOverlapMatch<Existing extends { id: string }> {
  connector: Existing;
  score: 0 | 1 | 2 | 3;
  dimensions: ReadonlyArray<"driver" | "base_url_host" | "auth_type">;
}

/**
 * Normalise a base_url to its lowercase host for comparison. Returns
 * an empty string when the input is null/empty/malformed. This is the
 * single source of truth for "are these two URLs on the same system"
 * — keep callers using it instead of inventing their own normalisers
 * so the same connectors collide and dedup the same way everywhere.
 */
export function baseUrlHost(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Score an existing connector against a proposed one. The match
 * object includes a list of dimensions on which the existing connector
 * agrees, so callers can render a precise diagnostic
 * ("matches on driver + base_url_host, differs on auth_type — confirm
 * before creating a duplicate").
 */
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

/**
 * Score a list of existing connectors and return the matches above
 * a threshold, sorted descending by score. The default threshold of
 * 2 surfaces "driver + host" matches (the case we are fixing) plus
 * the stronger "all three" matches.
 *
 * Use `minScore: 3` when you only want exact-shape reuse candidates;
 * use `minScore: 1` for any overlap (useful for diagnostics).
 */
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
