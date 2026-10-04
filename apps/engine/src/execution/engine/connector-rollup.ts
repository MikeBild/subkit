import type { AppliedAuthMethod, ConnectorResolutionSummary, ExecutionMode } from "../types.ts";

export function rollupConnectorResolutions(
  stepSummaries: Array<{
    step_key: string;
    request_meta?: Record<string, unknown> | null;
  }>,
  requested_environment: ExecutionMode,
): ConnectorResolutionSummary[] {
  const seen = new Set<string>();
  const out: ConnectorResolutionSummary[] = [];
  for (const s of stepSummaries) {
    const meta = s.request_meta;
    if (!meta || typeof meta !== "object") continue;
    const c = (meta as { connector?: Record<string, unknown> }).connector;
    if (!c || typeof c !== "object") continue;
    const id = typeof c.connector_id === "string" ? c.connector_id : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const resolvedEnv =
      c.resolved_environment === "dev" || c.resolved_environment === "prod"
        ? c.resolved_environment
        : requested_environment;
    out.push({
      step_key: s.step_key,
      connector_id: id,
      connector_slug: typeof c.connector_slug === "string" ? c.connector_slug : "",
      driver: typeof c.driver === "string" ? c.driver : "",
      requested_environment,
      resolved_environment: resolvedEnv,
      auth_method: normalizeAuthMethod(c.auth_method),
      base_url: typeof c.base_url === "string" ? c.base_url : null,
    });
  }
  return out;
}

function normalizeAuthMethod(v: unknown): AppliedAuthMethod {
  if (
    v === "none" ||
    v === "bearer" ||
    v === "header" ||
    v === "query" ||
    v === "basic" ||
    v === "oauth2_static" ||
    v === "oauth2_refreshed"
  ) {
    return v;
  }
  return "none";
}
