import { readEnv } from "../env.ts";
import { EgressBlockedError } from "./egress-guard.ts";

const REQUEST_FIELDS = [
  "body",
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "method",
  "mode",
  "referrer",
  "referrerPolicy",
  "signal",
] as const satisfies readonly (keyof RequestInit)[];

export async function fetchPinnedOrigin(
  target: URL,
  address: { address: string; family: number },
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ] as const) {
    if (readEnv(name)?.trim())
      throw new EgressBlockedError("proxy_environment_unsupported", target.hostname);
  }
  const pinned = new URL(target);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  const standard = Object.fromEntries(
    REQUEST_FIELDS.filter((key) => init[key] !== undefined).map((key) => [key, init[key]]),
  ) as RequestInit;
  const options = {
    ...standard,
    headers,
    redirect: "manual" as const,
    proxy: false as const,
    ...(target.protocol === "https:"
      ? { tls: { serverName: target.hostname.replace(/^\[|\]$/g, ""), rejectUnauthorized: true } }
      : {}),
  };
  const response = await fetchImpl(pinned, options);
  return logicalResponse(response, target.href);
}

function logicalResponse(response: Response, url: string): Response {
  const clone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { value: url, configurable: true },
    clone: { value: () => logicalResponse(clone(), url), configurable: true },
  });
  return response;
}
