// Outbound connections — the two calls this engine makes to the other side's
// endpoints: register as a public client (RFC 7591) and post to the token
// endpoint (RFC 6749). Plain requests and their answers, no rows, no secrets
// stored; service.ts decides what the answers mean for a connection.

import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
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
  return error instanceof Error ? error.message : String(error);
}

export async function registerClient(args: {
  metadata: AuthorizationServerMetadata;
  redirectUri: string;
  clientUri: string | null;
  scopes: string[];
}): Promise<string> {
  const endpoint = args.metadata.registration_endpoint;
  if (!endpoint) throw new ConnectionError("registration_missing", "no registration endpoint");
  let res: Response;
  try {
    res = await getDriverFetch()(endpoint, {
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
    const body = await res.text().catch(() => "");
    throw new ConnectionError(
      "registration_failed",
      `registration answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const parsed = RegistrationResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new ConnectionError("registration_failed", "registration answered without a client_id");
  }
  return parsed.data.client_id;
}

/**
 * The engine's own wording when a token endpoint answered with a non-2xx. The
 * detail after it is the OAuth `error` code when the body carried one, else
 * the bare HTTP status — which is what tells a refusal from a failure.
 */
const TOKEN_REFUSED_PREFIX = "token endpoint refused: ";

/**
 * Whether a failed renewal was the other side saying no: its token endpoint
 * answered with an RFC 6749 §5.2 error code. Read off `last_error`, which only
 * the engine writes (`postTokenEndpoint`); an unreachable endpoint, a bare
 * status or an answer without a token is a failure, not a refusal.
 */
export function refreshWasRefused(lastError: string | null): boolean {
  if (!lastError?.startsWith(TOKEN_REFUSED_PREFIX)) return false;
  return /^[a-z][a-z_]*$/.test(lastError.slice(TOKEN_REFUSED_PREFIX.length));
}

export async function postTokenEndpoint(
  tokenEndpoint: string,
  form: Record<string, string>,
  failureCode: "token_exchange_failed" | "refresh_failed",
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await getDriverFetch()(tokenEndpoint, {
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
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : String(res.status);
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

/**
 * The permissions the other side granted. Protocol scopes are dropped here, at
 * the one place a grant is read, so a server echoing `offline_access` on one
 * grant type and not the other never reads as a change of authority.
 */
export function grantedScopes(token: TokenResponse): string[] | null {
  if (typeof token.scope !== "string") return null;
  return permissionScopes([token.scope]);
}
