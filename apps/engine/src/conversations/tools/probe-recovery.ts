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
//   401 / 403         → setup_connector_credentials
//                       (auth rejected; refresh / re-enter token)
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
    return ["setup_connector_credentials", "fetch_connector_docs"];
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return ["probe_connector_draft", "fetch_connector_docs"];
  }
  return ["search_docs", "fetch_connector_docs", "update_connector_draft"];
}
