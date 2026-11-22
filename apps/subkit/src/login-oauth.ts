import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { EngineClient } from "./engine-client.ts";
import { defaultOpenBrowser } from "./lib/open-browser.ts";

export const CLI_LOGIN_SCOPE = "subkit:login";
const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface CliOAuthLoginResult {
  api_key: string;
  principal_id: string;
  context_id: string;
  email: string;
}

interface CliOAuthLoginOptions {
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

const DONE_PATH = "/signed-in";
const FAILED_PATH = "/sign-in-failed";
const RESULT_GRACE_MS = 5_000;

const PAGE_STYLE =
  ":root{color-scheme:light dark;--background:#fff;--foreground:#020817;--card:#fff;--muted-foreground:#64748b;--border:#e2e8f0;--primary:#0f172a;--primary-foreground:#f8fafc;--success:#059669;--destructive:#dc2626}" +
  "@media(prefers-color-scheme:dark){:root{--background:#020817;--foreground:#f8fafc;--card:#0b1220;--muted-foreground:#94a3b8;--border:#1e293b;--primary:#f8fafc;--primary-foreground:#0f172a}}" +
  "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--background);color:var(--foreground);font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}" +
  "main{width:100%;max-width:26rem;padding:32px 24px;border:1px solid var(--border);border-radius:12px;background:var(--card);text-align:center}" +
  "svg{display:block;margin:0 auto 20px}h1{margin:0 0 8px;font-size:1.25rem;font-weight:600}p{margin:0;color:var(--muted-foreground);line-height:1.5}" +
  ".status{display:inline-block;margin-bottom:12px;font-size:.875rem;font-weight:500}.ok{color:var(--success)}.bad{color:var(--destructive)}";

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="40" height="40" role="img" aria-label="SubKit"><rect width="32" height="32" rx="7" fill="var(--primary)"/><g fill="none" stroke="var(--primary-foreground)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(5 5) scale(0.9167)"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></g></svg>';

function resultHtml(ok: boolean): string {
  const status = ok ? "Signed in" : "Sign-in failed";
  const title = ok ? "Sign-in complete" : "Sign-in could not be completed";
  const body = ok
    ? "You are signed in to the SubKit CLI. Close this tab and return to the CLI."
    : "The SubKit CLI did not receive a valid sign-in. Close this tab, return to the CLI and run subkit login again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SubKit CLI</title><style>${PAGE_STYLE}</style></head><body><main>${LOGO_SVG}<span class="status ${ok ? "ok" : "bad"}">${status}</span><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

const RESULT_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  "referrer-policy": "no-referrer",
} as const;

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

  let settle: (() => void) | undefined;
  let resultServed = false;
  const settleOnce = () => {
    const run = settle;
    settle = undefined;
    run?.();
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === DONE_PATH || url.pathname === FAILED_PATH)) {
      const ok = url.pathname === DONE_PATH;
      res.writeHead(ok ? 200 : 400, RESULT_HEADERS);
      res.once("finish", () => {
        resultServed = true;
        settleOnce();
      });
      res.end(resultHtml(ok));
      return;
    }
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (settle || resultServed) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const failed = Boolean(error || !code || !state || state !== expectedState);
    clearTimeout(timer);
    settle = failed
      ? () =>
          rejectCallback?.(
            new Error(
              error
                ? `OAuth authorization failed: ${error}`
                : state && state !== expectedState
                  ? "OAuth callback state mismatch"
                  : "OAuth callback is incomplete",
            ),
          )
      : () => resolveCallback?.({ code: code as string, state: state as string });
    const grace = setTimeout(settleOnce, RESULT_GRACE_MS);
    grace.unref?.();
    res.writeHead(303, {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      location: failed ? FAILED_PATH : DONE_PATH,
    });
    res.end();
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
      software_id: "subkit-subkit",
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
