import type { EgressGuardContext } from "../../connectors/index.ts";
import { CredentialRequestError, fetchCredentialRequest } from "../request.ts";
import { permissionScopes } from "./scopes.ts";
import {
  type AuthorizationServerMetadata,
  ConnectionError,
  RegistrationResponseSchema,
  type TokenResponse,
  TokenResponseSchema,
} from "./types.ts";

const TOKEN_TIMEOUT_MS = 15_000;

export function messageOf(error: unknown): string {
  return error instanceof ConnectionError || error instanceof CredentialRequestError
    ? error.message
    : "connection_request_failed";
}

export async function registerClient(
  args: {
    metadata: AuthorizationServerMetadata;
    redirectUri: string;
    clientUri: string | null;
    scopes: string[];
  },
  context: EgressGuardContext,
): Promise<string> {
  const endpoint = args.metadata.registration_endpoint;
  if (!endpoint) throw new ConnectionError("registration_missing", "no registration endpoint");
  let res: Response;
  try {
    res = await fetchCredentialRequest(context, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      body: JSON.stringify({
        client_name: "SubKit",
        ...(args.clientUri ? { client_uri: args.clientUri } : {}),
        redirect_uris: [args.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: args.scopes.join(" "),
      }),
    });
  } catch (error) {
    throw new ConnectionError("registration_failed", `registration failed: ${messageOf(error)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ConnectionError("registration_failed", `registration_rejected: http_${res.status}`);
  }
  const parsed = RegistrationResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new ConnectionError("registration_failed", "registration answered without a client_id");
  }
  return parsed.data.client_id;
}

const SAFE_OAUTH_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "temporarily_unavailable",
  "server_error",
]);

const TOKEN_REFUSED_PREFIX = "token endpoint refused: ";

export function refreshWasRefused(lastError: string | null): boolean {
  if (!lastError?.startsWith(TOKEN_REFUSED_PREFIX)) return false;
  return /^(?:[a-z][a-z_]*|http_[1-5][0-9]{2})$/.test(lastError.slice(TOKEN_REFUSED_PREFIX.length));
}

export async function postTokenEndpoint(
  tokenEndpoint: string,
  form: Record<string, string>,
  failureCode: "token_exchange_failed" | "refresh_failed",
  context: EgressGuardContext,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchCredentialRequest(context, tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new ConnectionError(failureCode, `token endpoint unreachable: ${messageOf(error)}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const supplied = body && typeof body === "object" && "error" in body ? body.error : null;
    const detail =
      typeof supplied === "string" && SAFE_OAUTH_ERRORS.has(supplied)
        ? supplied
        : `http_${res.status}`;
    throw new ConnectionError(failureCode, `${TOKEN_REFUSED_PREFIX}${detail}`);
  }
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ConnectionError(failureCode, "token endpoint answered without an access token");
  }
  return parsed.data;
}

export function expiryOf(token: TokenResponse): Date | null {
  return typeof token.expires_in === "number"
    ? new Date(Date.now() + token.expires_in * 1000)
    : null;
}

export function grantedScopes(token: TokenResponse): string[] | null {
  if (typeof token.scope !== "string") return null;
  return permissionScopes([token.scope]);
}
