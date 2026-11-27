import {
  EgressBlockedError,
  type EgressGuardContext,
  type EgressLookup,
  resolveAllowedEgressAddresses,
  resolveEgressGuardMode,
  resolveTenantEgressContext,
} from "./egress-guard.ts";
import { localTlsOptions } from "./local-egress.ts";
import { fetchPinnedOrigin } from "./pinned-fetch.ts";

function withLocalTls(target: URL, init: RequestInit, context: EgressGuardContext): RequestInit {
  if (context.local_mcp_granted !== true) return init;
  const tls = localTlsOptions(target, context.local_mcp);
  return tls ? ({ ...init, tls } as RequestInit) : init;
}

export function guardedFetch(context: EgressGuardContext, fetchImpl: typeof fetch): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (input instanceof Request) {
        const resolved = await resolveTenantEgressContext(context);
        if (resolveEgressGuardMode(resolved) === "permissive") {
          return fetchImpl(input, withLocalTls(new URL(input.url), init ?? {}, resolved));
        }
        throw new EgressBlockedError("unsupported_request_input", new URL(input.url).hostname);
      }
      return fetchWithEgressGuard(input, init ?? {}, context, { fetchImpl });
    },
    { preconnect: () => {} },
  );
}

export async function fetchWithEgressGuard(
  url: URL | string,
  init: RequestInit,
  context: EgressGuardContext,
  dependencies: { fetchImpl: typeof fetch; lookupImpl?: EgressLookup },
): Promise<Response> {
  context = await resolveTenantEgressContext(context);
  if (resolveEgressGuardMode(context) === "permissive") {
    return dependencies.fetchImpl(url, withLocalTls(new URL(url), init, context));
  }
  let target = new URL(url);
  const request = { ...init };
  for (let hop = 0; hop <= 10; hop++) {
    if (!["https:", "http:"].includes(target.protocol)) {
      throw new EgressBlockedError("unsupported_protocol", target.hostname);
    }
    if (target.username || target.password) {
      throw new EgressBlockedError("url_credentials_blocked", target.hostname);
    }
    const addresses = await resolveAllowedEgressAddresses(target, context, dependencies);
    const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
    if (!address) throw new EgressBlockedError("dns_resolution_failed", target.hostname);
    request.signal?.throwIfAborted();
    const response = await fetchPinnedOrigin(
      target,
      address,
      request,
      dependencies.fetchImpl,
      context.local_mcp_granted === true ? localTlsOptions(target, context.local_mcp) : null,
    );
    if (![301, 302, 303, 307, 308].includes(response.status) || init.redirect === "manual") {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    if (init.redirect === "error")
      throw new EgressBlockedError("redirect_blocked", target.hostname);
    if (hop === 10) throw new EgressBlockedError("redirect_limit", target.hostname);
    const next = new URL(location, target);
    if (target.protocol === "https:" && next.protocol !== "https:") {
      throw new EgressBlockedError("redirect_downgrade", next.hostname);
    }
    if (next.origin !== target.origin) request.headers = {};
    const method = (request.method ?? "GET").toUpperCase();
    if (
      (response.status === 303 && method !== "HEAD") ||
      ([301, 302].includes(response.status) && method === "POST")
    ) {
      request.method = "GET";
      delete request.body;
      const headers = new Headers(request.headers);
      for (const name of [
        "content-type",
        "content-length",
        "content-encoding",
        "transfer-encoding",
      ]) {
        headers.delete(name);
      }
      request.headers = headers;
    } else if (request.body instanceof ReadableStream) {
      throw new EgressBlockedError("redirect_body_not_replayable", next.hostname);
    }
    if (next.origin !== target.origin && request.body != null) {
      throw new EgressBlockedError("redirect_cross_origin_body", next.hostname);
    }
    target = next;
  }
  throw new EgressBlockedError("redirect_limit", target.hostname);
}
