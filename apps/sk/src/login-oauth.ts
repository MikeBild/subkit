import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { EngineClient } from "./engine-client.ts";
import { defaultOpenBrowser } from "./lib/open-browser.ts";

export const CLI_LOGIN_SCOPE = "sk:login";
const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface CliOAuthLoginResult {
  api_key: string;
  principal_id: string;
  context_id: string;
  email: string;
}

export interface CliOAuthLoginOptions {
  engineUrl: string;
  tenantId?: string | undefined;
  client?: EngineClient | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  onAuthorizationUrl?: ((url: string) => void) | undefined;
  onBrowserLaunchError?: ((error: Error) => void) | undefined;
  timeoutMs?: number | undefined;
}

interface CallbackResult {
  code: string;
  state: string;
}

function normalizedEngineOrigin(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("engine URL must use HTTP(S)");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("remote engine URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("engine URL must not contain credentials, query, or fragment");
  }
  if (url.pathname !== "/") throw new Error("engine URL must be an origin without a path");
  return url.origin;
}

function validateEndpoint(raw: string, origin: string, expectedPath: string): string {
  const endpoint = new URL(raw);
  if (
    endpoint.origin !== origin ||
    endpoint.pathname !== expectedPath ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(`OAuth metadata returned an unexpected ${expectedPath} endpoint`);
  }
  return endpoint.toString();
}

function successHtml(): string {
  return "<!doctype html><meta charset=utf-8><title>SubKit CLI</title><p>Sign-in complete. You can close this tab.</p>";
}

function errorHtml(): string {
  return "<!doctype html><meta charset=utf-8><title>SubKit CLI</title><p>Sign-in could not be completed. Return to the terminal.</p>";
}

async function startCallbackServer(
  timeoutMs: number,
  expectedState: string,
): Promise<{
  server: Server;
  redirectUri: string;
  callback: Promise<CallbackResult>;
  cancelTimeout: () => void;
}> {
  let resolveCallback: ((result: CallbackResult) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  const callback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const timer = setTimeout(() => rejectCallback?.(new Error("OAuth login timed out")), timeoutMs);
  timer.unref?.();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error || !code || !state || state !== expectedState) {
      res.writeHead(400, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      res.end(errorHtml());
      clearTimeout(timer);
      rejectCallback?.(
        new Error(
          error
            ? `OAuth authorization failed: ${error}`
            : state && state !== expectedState
              ? "OAuth callback state mismatch"
              : "OAuth callback is incomplete",
        ),
      );
      return;
    }
    res.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    res.end(successHtml());
    clearTimeout(timer);
    resolveCallback?.({ code, state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve()); // allow-wall-clock
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not open the local OAuth callback listener");
  }
  return {
    server,
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    callback,
    cancelTimeout: () => clearTimeout(timer),
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function runCliOAuthLogin(
  options: CliOAuthLoginOptions,
): Promise<CliOAuthLoginResult> {
  const origin = normalizedEngineOrigin(options.engineUrl);
  const resource = `${origin}/v1/identity/cli-session`;
  const client = options.client ?? new EngineClient({ engine_url: origin, api_key: "" });
  if (client.base !== origin) throw new Error("OAuth client origin does not match the engine URL");

  const protectedResource = await client.oauthCliProtectedResource();
  if (
    protectedResource.resource !== resource ||
    !protectedResource.authorization_servers.includes(origin) ||
    !protectedResource.scopes_supported.includes(CLI_LOGIN_SCOPE)
  ) {
    throw new Error("engine OAuth protected-resource metadata does not match CLI login");
  }
  const metadata = await client.oauthAuthorizationServer();
  if (metadata.issuer !== origin) throw new Error("OAuth issuer does not match the engine origin");
  validateEndpoint(metadata.authorization_endpoint, origin, "/v1/oauth/authorize");
  validateEndpoint(metadata.token_endpoint, origin, "/v1/oauth/token");
  validateEndpoint(metadata.registration_endpoint, origin, "/v1/oauth/register");
  validateEndpoint(metadata.revocation_endpoint, origin, "/v1/oauth/revoke");
  if (
    !metadata.response_types_supported.includes("code") ||
    !metadata.grant_types_supported.includes("authorization_code") ||
    !metadata.code_challenge_methods_supported.includes("S256") ||
    !metadata.token_endpoint_auth_methods_supported.includes("none") ||
    !metadata.scopes_supported.includes(CLI_LOGIN_SCOPE)
  ) {
    throw new Error("engine OAuth metadata does not support the required public-client flow");
  }

  const state = randomBytes(32).toString("base64url");
  const listener = await startCallbackServer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, state);
  const callbackOutcome = listener.callback.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  try {
    const registered = await client.registerOAuthClient({
      redirect_uris: [listener.redirectUri],
      client_name: "SubKit CLI",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: CLI_LOGIN_SCOPE,
      software_id: "subkit-sk",
    });
    if (
      !registered.client_id ||
      registered.token_endpoint_auth_method !== "none" ||
      !registered.redirect_uris.includes(listener.redirectUri) ||
      registered.scope !== CLI_LOGIN_SCOPE ||
      !registered.grant_types.includes("authorization_code")
    ) {
      throw new Error("OAuth client registration response is invalid");
    }

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", registered.client_id);
    authorizationUrl.searchParams.set("redirect_uri", listener.redirectUri);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("scope", CLI_LOGIN_SCOPE);
    authorizationUrl.searchParams.set("resource", resource);
    authorizationUrl.searchParams.set("state", state);
    if (options.tenantId) authorizationUrl.searchParams.set("tenant_id", options.tenantId);
    options.onAuthorizationUrl?.(authorizationUrl.toString());
    try {
      await (options.openBrowser ?? defaultOpenBrowser)(authorizationUrl.toString());
    } catch (error) {
      const browserError = error instanceof Error ? error : new Error(String(error));
      if (!options.onAuthorizationUrl) throw browserError;
      options.onBrowserLaunchError?.(browserError);
    }

    const outcome = await callbackOutcome;
    if (!outcome.ok) throw outcome.error;
    const callback = outcome.value;
    if (callback.state !== state) throw new Error("OAuth callback state mismatch");
    const tokens = await client.exchangeOAuthAuthorizationCode({
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      client_id: registered.client_id,
    });
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      tokens.token_type.toLowerCase() !== "bearer" ||
      tokens.scope !== CLI_LOGIN_SCOPE
    ) {
      throw new Error("OAuth token response is invalid");
    }
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    const credential = await client.exchangeCliSession(accessToken);
    if (
      !credential.api_key ||
      !credential.principal_id ||
      !credential.context_id ||
      !credential.email
    ) {
      throw new Error("CLI session response is invalid");
    }
    if (options.tenantId && credential.context_id !== options.tenantId) {
      throw new Error("CLI session tenant does not match the selected workspace");
    }
    return credential;
  } finally {
    listener.cancelTimeout();
    await closeServer(listener.server);
    if (accessToken) await client.revokeOAuthToken(accessToken).catch(() => undefined);
    if (refreshToken) await client.revokeOAuthToken(refreshToken).catch(() => undefined);
  }
}
