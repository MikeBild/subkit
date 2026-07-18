// Trace middleware — generates a trace_id, attaches it to the Hono context
// + response header, and runs the rest of the request inside an async-local
// withContext({trace_id, request_source}).

import type { MiddlewareHandler } from "hono";
import { withContext } from "../../logging/context.ts";
import type { AppEnv } from "../openapi.ts";

function detectSource(path: string): AppEnv["Variables"]["request_source"] {
  if (path.startsWith("/mcp")) return "mcp";
  if (path.startsWith("/v1/hooks")) return "webhook";
  if (path.startsWith("/v1/chat")) return "chat";
  return "api";
}

// Accept a CLI-provided trace id so the user's local debug log
// records and the engine's structured logs share the same id. Pattern
// kept tight — `[A-Za-z0-9_-]{8,128}` — to refuse log-injection.
const INBOUND_TRACE_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * W3C trace-context header format. The spec is `version-traceId-parentId-flags`
 * with hex-only fields of fixed widths:
 *   version  = 2 hex (00)
 *   trace-id = 32 hex
 *   parent-id = 16 hex
 *   flags    = 2 hex
 */
const TRACEPARENT_RE = /^(00)-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ParsedTraceparent {
  /** 32-hex trace-id surfaced as our `trace_id` for downstream logging. */
  trace_id: string;
  /** 16-hex parent span id; preserved so outbound calls can reference it. */
  parent_id: string;
  /** 2-hex flags byte (sampled bit etc). */
  flags: string;
  /** The full normalised header value to echo on outbound fetches. */
  raw: string;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | null {
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  // W3C Trace Context forbids the all-zero trace-id and parent-id. Treat
  // either as malformed and start a fresh trace instead of propagating it.
  if (/^0{32}$/.test(m[2] ?? "") || /^0{16}$/.test(m[3] ?? "")) return null;
  return {
    trace_id: (m[2] ?? "").toLowerCase(),
    parent_id: (m[3] ?? "").toLowerCase(),
    flags: (m[4] ?? "").toLowerCase(),
    raw: `${m[1]?.toLowerCase() ?? "00"}-${m[2]?.toLowerCase() ?? ""}-${m[3]?.toLowerCase() ?? ""}-${m[4]?.toLowerCase() ?? ""}`,
  };
}

function inboundTraceId(c: { req: { header: (n: string) => string | undefined } }): string | null {
  // W3C traceparent wins when present — it's the standard, supersedes our
  // bespoke headers for any caller that sends it.
  const tp = parseTraceparent(c.req.header("traceparent"));
  if (tp) return tp.trace_id;
  const candidates = [c.req.header("x-sk-trace-id"), c.req.header("x-trace-id")];
  for (const raw of candidates) {
    if (raw && INBOUND_TRACE_ID.test(raw)) return raw;
  }
  return null;
}

export function traceMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inboundTraceparent = parseTraceparent(c.req.header("traceparent"));
    const trace_id = inboundTraceId(c) ?? randomTraceId();
    const span_id = randomSpanId();
    const source = detectSource(new URL(c.req.url).pathname);
    c.set("trace_id", trace_id);
    c.set("span_id", span_id);
    c.set("request_source", source);
    c.set("request_started_at", Date.now());
    c.header("x-trace-id", trace_id);
    // A server MUST create a new span; the inbound parent-id identifies the
    // caller and must not be echoed as if it were this server span.
    c.header(
      "traceparent",
      `00-${inboundTraceparent?.trace_id ?? padTraceId(trace_id)}-${span_id}-${inboundTraceparent?.flags ?? "00"}`,
    );

    await withContext({ trace_id, span_id, request_source: source }, async () => {
      await next();
    });
  };
}

/** Map a valid legacy x-trace-id to the W3C 128-bit trace-id field. */
function padTraceId(input: string): string {
  // Map any input to 32 lowercase hex chars deterministically. Pure-ASCII
  // hex inputs (UUID-shaped) get their hyphens stripped; others fall
  // through to a hex digest.
  const compact = input.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (compact.length >= 32) return compact.slice(0, 32);
  // FNV-1a-style fold — quick deterministic spread; cryptographic
  // strength isn't needed because the trace id is already public on
  // the response.
  let hash = 0xcbf29ce4_84222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  const filled = (compact + hash.toString(16).padStart(16, "0").repeat(2)).slice(0, 32);
  return filled.length === 32 ? filled : filled.padEnd(32, "0");
}

function randomSpanId(): string {
  return randomHex(8);
}

function randomTraceId(): string {
  return randomHex(16);
}

function randomHex(byteLength: number): string {
  // The all-zero value is invalid in W3C Trace Context. The loop almost
  // always executes once but makes the invariant explicit and testable.
  for (;;) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!/^0+$/.test(value)) return value;
  }
}
