// Applies a timeout and strips hop-by-hop headers that confuse a WebSocket-relayed round trip.

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface AgentFetchRequest {
  local_base_url: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface AgentFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  error?: string | null;
}

function joinUrl(base: string, pathAndQuery: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!pathAndQuery.startsWith("/")) return `${trimmedBase}/${pathAndQuery}`;
  return `${trimmedBase}${pathAndQuery}`;
}

function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export async function agentFetch(req: AgentFetchRequest): Promise<AgentFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), req.timeoutMs ?? 30_000);
  try {
    const url = joinUrl(req.local_base_url, req.path);
    const init: RequestInit = {
      method: req.method,
      headers: filterHeaders(req.headers),
      signal: controller.signal,
    };
    if (req.body != null && req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
    }
    const res = await fetch(url, init);
    const text = await res.text();
    const headerObj: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k.toLowerCase())) return;
      headerObj[k] = v;
    });
    return {
      status: res.status,
      headers: headerObj,
      body: text,
    };
  } catch (err) {
    return {
      status: 0,
      headers: {},
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
