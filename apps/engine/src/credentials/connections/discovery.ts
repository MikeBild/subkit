import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import {
  type AuthorizationServerMetadata,
  AuthorizationServerMetadataSchema,
  ConnectionError,
  type DiscoveryResult,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
} from "./types.ts";

const DISCOVERY_TIMEOUT_MS = 10_000;

export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ConnectionError("base_url_invalid", "the address is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConnectionError("base_url_invalid", "the address must start with https://");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !local) {
    throw new ConnectionError(
      "base_url_invalid",
      "plain http is only allowed for localhost; use https://",
    );
  }
  if (url.search || url.hash) {
    throw new ConnectionError("base_url_invalid", "the address must not carry a query or #");
  }
  url.username = "";
  url.password = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const res = await getDriverFetch()(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    redirect: "follow",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function discoverAuthorization(baseUrl: string): Promise<AuthorizationServerMetadata | null> {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ]) {
    let body: unknown;
    try {
      body = await fetchJson(`${baseUrl}${path}`);
    } catch (error) {
      throw new ConnectionError(
        "discovery_failed",
        `could not read ${path} at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (body === null) continue;
    const parsed = AuthorizationServerMetadataSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConnectionError(
        "discovery_failed",
        `${path} at ${baseUrl} is not authorization-server metadata: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  }
  return null;
}

async function discoverDescriptor(baseUrl: string): Promise<ServiceDescriptor | null> {
  let body: unknown;
  try {
    body = await fetchJson(`${baseUrl}/.well-known/service-descriptor.json`);
  } catch {
    return null;
  }
  if (body === null) return null;
  const parsed = ServiceDescriptorSchema.safeParse(body);
  if (!parsed.success) return null;
  const name = parsed.data.name ?? parsed.data.title ?? parsed.data.service ?? null;
  return {
    name: name ? name.slice(0, 120) : null,
    description: parsed.data.description ? parsed.data.description.slice(0, 500) : null,
    version: parsed.data.version ?? null,
  };
}

export async function discoverService(rawBaseUrl: string): Promise<DiscoveryResult> {
  const base_url = normalizeBaseUrl(rawBaseUrl);
  const [authorization, descriptor] = await Promise.all([
    discoverAuthorization(base_url),
    discoverDescriptor(base_url),
  ]);
  return { base_url, authorization, descriptor };
}

export function requireConnectable(result: DiscoveryResult): AuthorizationServerMetadata {
  if (!result.authorization) {
    throw new ConnectionError(
      "discovery_missing",
      `${result.base_url} publishes no authorization-server metadata`,
    );
  }
  const methods = result.authorization.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new ConnectionError("pkce_unsupported", `${result.base_url} does not support PKCE S256`);
  }
  if (!result.authorization.registration_endpoint) {
    throw new ConnectionError(
      "registration_missing",
      `${result.base_url} offers no dynamic client registration`,
    );
  }
  return result.authorization;
}
