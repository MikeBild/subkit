import type { MiddlewareHandler } from "hono";
import { withIsolatedContext } from "../../logging/context.ts";
import type { AppEnv } from "../openapi.ts";

function detectSource(path: string): AppEnv["Variables"]["request_source"] {
  if (path.startsWith("/mcp")) return "mcp";
  if (path.startsWith("/v1/hooks")) return "webhook";
  if (path.startsWith("/v1/chat")) return "chat";
  return "api";
}

const INBOUND_TRACE_ID = /^[A-Za-z0-9_-]{8,128}$/;

const TRACEPARENT_RE = /^(00)-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ParsedTraceparent {
  trace_id: string;
  parent_id: string;
  flags: string;
  raw: string;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | null {
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  if (/^0{32}$/.test(m[2] ?? "") || /^0{16}$/.test(m[3] ?? "")) return null;
  return {
    trace_id: (m[2] ?? "").toLowerCase(),
    parent_id: (m[3] ?? "").toLowerCase(),
    flags: (m[4] ?? "").toLowerCase(),
    raw: `${m[1]?.toLowerCase() ?? "00"}-${m[2]?.toLowerCase() ?? ""}-${m[3]?.toLowerCase() ?? ""}-${m[4]?.toLowerCase() ?? ""}`,
  };
}

function inboundTraceId(c: { req: { header: (n: string) => string | undefined } }): string | null {
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
    c.header(
      "traceparent",
      `00-${inboundTraceparent?.trace_id ?? padTraceId(trace_id)}-${span_id}-${inboundTraceparent?.flags ?? "00"}`,
    );

    await withIsolatedContext(
      {
        trace_id,
        span_id,
        request_source: source,
      },
      async () => {
        await next();
      },
    );
  };
}

function padTraceId(input: string): string {
  const compact = input.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (compact.length >= 32) return compact.slice(0, 32);
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
  for (;;) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!/^0+$/.test(value)) return value;
  }
}
