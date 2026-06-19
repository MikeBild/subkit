// Probe-failure diagnostics.
//
// Pre-fix a failing probe collapsed the upstream response into a bare
// "GraphQL probe failed: HTTP 403" — three consecutive 403 probes in a
// row dropped the response body and headers that named the real
// problem ("Basic auth with password is not allowed on this instance",
// `X-Seraph-LoginReason: AUTHENTICATED_FAILED`), forcing the LLM and
// the operator to guess. These helpers extract a scrubbed, truncated
// body snippet plus an allowlisted set of diagnostic response headers
// so every ok:false probe carries the upstream's own words.
//
// Pure module — no I/O, sibling style to `probe-classify.ts`.

import { scrubString } from "../../logging/scrub-secrets.ts";

export interface ProbeDiagnostics {
  body_snippet?: string;
  response_headers?: Record<string, string>;
}

const BODY_SNIPPET_MAX = 500;

// Headers that carry diagnostic signal without leaking secrets.
// `www-authenticate` names the expected auth scheme/realm;
// `content-type` distinguishes an HTML login wall from a JSON error.
const EXACT_HEADER_ALLOWLIST = new Set(["www-authenticate", "content-type"]);
// Vendor diagnostic headers (e.g. Atlassian `x-seraph-loginreason`,
// `x-request-id` for support tickets). Narrow on purpose: only x-*
// headers whose name signals auth/error/diagnostic intent pass.
const PATTERN_HEADER_ALLOWLIST =
  /^x-[a-z0-9-]*(auth|error|reason|login|deny|request-id)[a-z0-9-]*$/i;

/**
 * Build the diagnostic envelope for a failed probe from the upstream
 * response headers + body. Returns `{}` when nothing survives, so call
 * sites can spread the result unconditionally.
 */
export function buildProbeDiagnostics(
  headers: Record<string, string> | undefined,
  body: unknown,
): ProbeDiagnostics {
  const out: ProbeDiagnostics = {};

  if (body != null) {
    let raw: string | undefined;
    if (typeof body === "string") {
      raw = body;
    } else {
      try {
        raw = JSON.stringify(body);
      } catch {
        // Circular / non-serializable body — no snippet.
        raw = undefined;
      }
    }
    if (raw !== undefined && raw.length > 0) {
      const scrubbed = scrubString(raw);
      if (scrubbed.length > 0) {
        out.body_snippet =
          scrubbed.length > BODY_SNIPPET_MAX
            ? `${scrubbed.slice(0, BODY_SNIPPET_MAX)}… [+${scrubbed.length - BODY_SNIPPET_MAX} chars]`
            : scrubbed;
      }
    }
  }

  if (headers) {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (EXACT_HEADER_ALLOWLIST.has(lower) || PATTERN_HEADER_ALLOWLIST.test(lower)) {
        kept[lower] = scrubString(value);
      }
    }
    if (Object.keys(kept).length > 0) {
      out.response_headers = kept;
    }
  }

  return out;
}
