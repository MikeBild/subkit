// Structured error detail builder shared by every driver path.
//
// Pre-fix the engine collapsed driver failures to `{ code, message }` and
// `String(err)` produced `"[object Object]"` whenever the cause was a non-
// Error value. The LLM author saw `http 404` or `[object Object]` in chat
// and could not tell whether the path was wrong, the credential expired,
// or a placeholder failed to substitute. Session f00b8d1c spent 19 of
// its 109 DigitalOcean calls on that blind 404 → re-author cycle.
//
// `buildStepErrorDetail` extracts whatever the failure already knows
// (resolved URL from request_meta, response body + status from
// `RequestError.meta`, original `err.cause`) and returns a flat envelope
// the dry-run / RunResult surface persists verbatim.
//
// Privacy: cookie / authorization / x-api-key / set-cookie headers are
// dropped from `response_headers`. Credential placeholder previews are
// always rendered as `***`.

import type { RequestMeta, StepErrorDetail } from "../types.ts";

const SAFE_HEADER_DENYLIST = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
]);

/** First 4 KB of an opaque body, JSON-serialised when shaped, raw text otherwise. */
function bodyExcerpt(body: unknown, maxBytes = 4096): string | undefined {
  if (body === undefined || body === null) return undefined;
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  if (text.length === 0) return undefined;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Fast path: byte-truncate then trim trailing partial UTF-8.
  const buf = Buffer.from(text, "utf8");
  return `${buf.subarray(0, maxBytes).toString("utf8")} …[truncated]`;
}

function safeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SAFE_HEADER_DENYLIST.has(lower)) continue;
    if (typeof v === "string") out[lower] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[lower] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickRequestErrorMeta(err: unknown): {
  status?: number;
  body?: unknown;
  headers?: unknown;
} | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; meta?: Record<string, unknown> };
  const meta = e.meta ?? {};
  const out: { status?: number; body?: unknown; headers?: unknown } = {};
  if (typeof e.status === "number") out.status = e.status;
  if ("body" in meta) out.body = (meta as Record<string, unknown>).body;
  if ("headers" in meta) out.headers = (meta as Record<string, unknown>).headers;
  return out.status === undefined && out.body === undefined && out.headers === undefined
    ? null
    : out;
}

function pickHealthHint(err: unknown): {
  health: string;
  error_code?: string;
  suggestion?: string;
  next_best_actions?: string[];
} | null {
  if (!err || typeof err !== "object") return null;
  const meta = (err as { meta?: Record<string, unknown> }).meta;
  const hint = meta?.health_hint;
  if (!hint || typeof hint !== "object") return null;
  const h = hint as Record<string, unknown>;
  if (typeof h.health !== "string") return null;
  return {
    health: h.health,
    ...(typeof h.error_code === "string" ? { error_code: h.error_code } : {}),
    ...(typeof h.suggestion === "string" ? { suggestion: h.suggestion } : {}),
    ...(Array.isArray(h.next_best_actions)
      ? { next_best_actions: h.next_best_actions.filter((a): a is string => typeof a === "string") }
      : {}),
  };
}

function pickResolvedUrl(meta: RequestMeta | null | undefined): string | undefined {
  if (!meta) return undefined;
  if (meta.driver === "http" || meta.driver === "connectorless") {
    return meta.url ?? undefined;
  }
  if (meta.driver === "s3") {
    return meta.key ?? meta.prefix ?? undefined;
  }
  return undefined;
}

function pickUnresolvedPlaceholders(
  meta: RequestMeta | null | undefined,
): Array<{ name: string; preview: string }> | undefined {
  if (!meta) return undefined;
  if (meta.driver === "http" || meta.driver === "connectorless" || meta.driver === "error") {
    const list = meta.unresolved_placeholders ?? [];
    if (list.length === 0) return undefined;
    return list.map((name) => ({ name, preview: "<unresolved>" }));
  }
  return undefined;
}

export interface BuildStepErrorOptions {
  code: string;
  /** Original thrown value. */
  err: unknown;
  /** Last `request_meta` snapshot the dispatcher published before the failure. */
  request_meta?: RequestMeta | null;
  /** Optional override message — used when the call site already has a
   *  curated string (e.g. "request exceeded 60000ms"). When omitted the
   *  helper prefers `err.message`, then `err.cause.message`, then a
   *  driver-shaped fallback that NEVER returns `[object Object]`. */
  message?: string;
}

/** Render a non-Error throwable into a useful string.
 *  Replaces the historic `String(err)` → `"[object Object]"` fallback. */
function safeMessage(err: unknown, fallback: string): string {
  // Belt-and-suspenders: even when err is a proper Error, its `.message`
  // can be the literal "[object Object]" if upstream code template-stringed
  // an object into the Error constructor. Treat that as no-detail and try
  // the cause/JSON paths below instead of propagating the useless string.
  if (err instanceof Error) {
    const direct = err.message;
    if (typeof direct === "string" && direct.length > 0 && direct !== "[object Object]") {
      return direct;
    }
    const causeMsg = pickCauseMessage(err);
    if (causeMsg) return causeMsg;
    return fallback;
  }
  if (err === null || err === undefined) return fallback;
  if (typeof err === "string") {
    return err && err !== "[object Object]" ? err : fallback;
  }
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.length > 0 && o.message !== "[object Object]") {
      return o.message;
    }
    try {
      const json = JSON.stringify(o);
      if (json && json !== "{}") return json;
    } catch {
      // fall through
    }
  }
  return fallback;
}

function pickCauseMessage(err: Error): string | null {
  const cause = (err as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const msg = (cause as { message?: unknown }).message;
  if (typeof msg === "string" && msg.length > 0 && msg !== "[object Object]") {
    return msg;
  }
  return null;
}

export function buildStepErrorDetail(opts: BuildStepErrorOptions): StepErrorDetail {
  const { code, err, request_meta, message } = opts;
  const fallbackMessage = `${code} (no detail)`;
  const detail: StepErrorDetail = {
    code,
    message: message ?? safeMessage(err, fallbackMessage),
  };
  const reqMeta = pickRequestErrorMeta(err);
  if (reqMeta) {
    if (reqMeta.status !== undefined) detail.upstream_status = reqMeta.status;
    if (reqMeta.body !== undefined) {
      const excerpt = bodyExcerpt(reqMeta.body);
      if (excerpt !== undefined) detail.response_body_excerpt = excerpt;
    }
    const headers = safeHeaders(reqMeta.headers);
    if (headers) detail.response_headers = headers;
  }
  // Connector-health verdict + actionable hint attached at the dispatch
  // throw site (`meta.health_hint`). This is what turns a bare `http 410`
  // in chat into "the vendor removed this endpoint — check docs for the
  // replacement" — the LLM/operator can act instead of guessing.
  const healthHint = pickHealthHint(err);
  if (healthHint) {
    detail.health = healthHint.health;
    if (healthHint.error_code) detail.health_error_code = healthHint.error_code;
    if (healthHint.suggestion) detail.guidance = healthHint.suggestion;
    if (healthHint.next_best_actions && healthHint.next_best_actions.length > 0) {
      detail.next_best_actions = healthHint.next_best_actions;
    }
  }
  const resolvedUrl = pickResolvedUrl(request_meta);
  if (resolvedUrl) detail.resolved_url = resolvedUrl;
  const unresolved = pickUnresolvedPlaceholders(request_meta);
  if (unresolved) detail.resolved_placeholders = unresolved;
  // Surface err.cause.message when the immediate `err.message` was generic
  // (e.g. `"request_error"` or empty). Cause is a common Node.js convention
  // for upstream connection failures.
  if ((!detail.message || detail.message === fallbackMessage) && err && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeMsg = (cause as { message?: unknown }).message;
      if (typeof causeMsg === "string" && causeMsg.length > 0) {
        detail.message = causeMsg;
      }
    }
  }
  return detail;
}
