import type { RequestMeta, StepErrorDetail } from "../types.ts";

export const SAFE_HEADER_DENYLIST = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
]);

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
  err: unknown;
  request_meta?: RequestMeta | null;
  message?: string;
}

function safeMessage(err: unknown, fallback: string): string {
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
    } catch {}
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
  const healthHint = pickHealthHint(err);
  if (healthHint) {
    detail.health = healthHint.health;
    if (healthHint.error_code) detail.health_error_code = healthHint.error_code;
    if (healthHint.suggestion) detail.guidance = healthHint.suggestion;
    if (healthHint.next_best_actions && healthHint.next_best_actions.length > 0) {
      detail.next_best_actions = healthHint.next_best_actions;
    }
  }
  const refusalReason = (err as { meta?: Record<string, unknown> } | null)?.meta?.refusal_reason;
  if (typeof refusalReason === "string") detail.reason = refusalReason;
  const resolvedUrl = pickResolvedUrl(request_meta);
  if (resolvedUrl) detail.resolved_url = resolvedUrl;
  const unresolved = pickUnresolvedPlaceholders(request_meta);
  if (unresolved) detail.resolved_placeholders = unresolved;
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
