// Shared "what should the LLM try next?" mapper for probe-style
// failures. Probe-equivalent failures fall into a small set of
// categories (auth, missing path, transient, timeout) and each one
// has a single best recovery move; surfacing the move as
// `next_best_actions` lets the LLM converge in 1 retry instead of
// reasoning from scratch.
//
// Used by:
//   - probe_connector_draft (the original site)
//   - probe_connector (post-save probe of an existing connector)
//   - dry_run_step (per-step request failure during workflow
//     authoring — same auth/path/transient bucketing applies)
//
// Mapping reference:
//   404               → search_docs / discover_connector_endpoints
//                       (the path was wrong; pull the catalog)
//   401 / 403         → setup_connector_credentials OR fix base_url. Auth
//                       rejection is NOT proof the credential is bad: a valid
//                       credential is also rejected by the WRONG host/site.
//                       This is the common tenant-subdomain SaaS trap
//                       (*.atlassian.net, *.zendesk.com, *.myshopify.com,
//                       *.okta.com, …) where the host is guessed wrong — so
//                       offer update_connector_draft alongside re-credentialing.
//   429 / 5xx         → wait + retry (transient — same probe later)
//   timeout           → reduce probe scope or check connector base_url
//   anything else     → search_docs (catch-all for path / shape drift)

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
    // `update_connector_draft` (fix base_url) sits alongside re-credentialing:
    // a valid credential 401s against the wrong host, so both are real fixes.
    return ["setup_connector_credentials", "update_connector_draft", "fetch_connector_docs"];
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return ["probe_connector_draft", "fetch_connector_docs"];
  }
  return ["search_docs", "fetch_connector_docs", "update_connector_draft"];
}

/**
 * Human-readable hint appended to a probe-failure summary. `pickProbeRecoveryActions`
 * says WHICH tools to try; this explains WHY, so the LLM doesn't misattribute the
 * failure. The load-bearing case: a 401/403 is not proof the credential expired —
 * a valid credential is rejected by the wrong host/site too. Vendor-neutral: it
 * never names a provider, it points at `base_url`. Returns "" when there's no
 * status-specific caveat to add.
 */
export function probeStatusHint(status: number): string {
  if (status === 401 || status === 403) {
    return " The host rejected the credential. If the credential is known-good, verify base_url targets the correct host/site before re-collecting it — a valid credential still returns this status against the wrong host (e.g. a guessed tenant subdomain).";
  }
  if (status === 404) {
    return " The path or host may be wrong — check the endpoint against the connector docs/catalog and verify base_url.";
  }
  return "";
}
