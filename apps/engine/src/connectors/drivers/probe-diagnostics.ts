import { scrubString } from "../../logging/scrub-secrets.ts";

export interface ProbeDiagnostics {
  body_snippet?: string;
  response_headers?: Record<string, string>;
}

const BODY_SNIPPET_MAX = 500;

const EXACT_HEADER_ALLOWLIST = new Set(["www-authenticate", "content-type"]);
const PATTERN_HEADER_ALLOWLIST =
  /^x-[a-z0-9-]*(auth|error|reason|login|deny|request-id)[a-z0-9-]*$/i;

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
