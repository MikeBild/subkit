import type { EgressGuardContext } from "../../connectors/index.ts";
import { CredentialRequestError, fetchCredentialRequest } from "../request.ts";
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

async function fetchJson(url: string, context: EgressGuardContext): Promise<unknown | null> {
  const res = await fetchCredentialRequest(context, url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    redirect: "follow",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new CredentialRequestError("credential_response_rejected", res.status);
  return res.json();
}

async function discoverAuthorization(
  baseUrl: string,
  context: EgressGuardContext,
): Promise<AuthorizationServerMetadata | null> {
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ]) {
    let body: unknown;
    try {
      body = await fetchJson(`${baseUrl}${path}`, context);
    } catch (error) {
      throw new ConnectionError(
        "discovery_failed",
        error instanceof CredentialRequestError ? error.message : "discovery_request_failed",
      );
    }
    if (body === null) continue;
    const parsed = AuthorizationServerMetadataSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConnectionError("discovery_failed", "discovery_metadata_invalid");
    }
    return parsed.data;
  }
  return null;
}

async function discoverDescriptor(
  baseUrl: string,
  context: EgressGuardContext,
): Promise<ServiceDescriptor | null> {
  let body: unknown;
  try {
    body = await fetchJson(`${baseUrl}/.well-known/service-descriptor.json`, context);
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

export async function discoverService(
  rawBaseUrl: string,
  context: EgressGuardContext,
): Promise<DiscoveryResult> {
  const base_url = normalizeBaseUrl(rawBaseUrl);
  const [authorization, descriptor] = await Promise.all([
    discoverAuthorization(base_url, context),
    discoverDescriptor(base_url, context),
  ]);
  return { base_url, authorization, descriptor };
}

export function requireConnectable(result: DiscoveryResult): AuthorizationServerMetadata {
  if (!result.authorization) {
    throw new ConnectionError("discovery_missing", "authorization_metadata_missing");
  }
  const methods = result.authorization.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new ConnectionError("pkce_unsupported", "pkce_s256_unsupported");
  }
  if (!result.authorization.registration_endpoint) {
    throw new ConnectionError("registration_missing", "dynamic_registration_missing");
  }
  return result.authorization;
}
