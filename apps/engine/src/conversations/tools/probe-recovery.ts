export interface ProbeFailureSignal {
  status?: number | null | undefined;
  failure_code?: string | null | undefined;
}

export function pickProbeRecoveryActions(signal: ProbeFailureSignal): string[] {
  const status = signal.status ?? 0;
  if (signal.failure_code === "probe_timeout" || signal.failure_code === "request_timeout") {
    return ["update_connector_draft", "fetch_connector_docs"];
  }
  if (status === 404) {
    return ["search_docs", "discover_connector_endpoints", "update_connector_draft"];
  }
  if (status === 401 || status === 403) {
    return ["setup_connector_credentials", "update_connector_draft", "fetch_connector_docs"];
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return ["probe_connector_draft", "fetch_connector_docs"];
  }
  return ["search_docs", "fetch_connector_docs", "update_connector_draft"];
}

export function probeStatusHint(status: number): string {
  if (status === 401 || status === 403) {
    return " The host rejected the credential. If the credential is known-good, verify base_url targets the correct host/site before re-collecting it — a valid credential still returns this status against the wrong host (e.g. a guessed tenant subdomain).";
  }
  if (status === 404) {
    return " The path or host may be wrong — check the endpoint against the connector docs/catalog and verify base_url.";
  }
  return "";
}
