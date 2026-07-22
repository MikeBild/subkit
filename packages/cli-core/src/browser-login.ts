// Provider-neutral browser login flow for externally hosted token bridges.
//
// Flow:
//   1. Start a temporary HTTP server on a random localhost port
//   2. Open the provider's login URL with callback_port + state params
//   3. User authenticates with the configured deployment adapter
//   4. The bridge redirects to localhost with an identity assertion
//   5. Exchange it at POST /v1/identity/sessions using the configured provider id
//   6. Return the API key
//
// This complements RFC 8628 for token-bridge adapters.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface BrowserLoginOptions {
  /** Configured provider id returned by GET /v1/identity/providers. */
  provider_id: string;
  /** The URL of the deployment-owned login bridge. */
  login_url: string;
  /** The SubKit engine URL used for the assertion exchange. */
  engine_url: string;
  /** Optional: override the localhost port (default: random) */
  port?: number;
  /** Optional timeout in ms (default: 120_000 = 2 min) */
  timeout_ms?: number;
  /** Optional: suppress console output (for tests) */
  quiet?: boolean;
  /** Optional: custom fetch implementation (for tests) */
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface BrowserLoginResult {
  api_key: string;
  user_id: string;
  tenant_id: string;
  email: string;
}

/**
 * Run the browser-based login flow. Opens a browser to the login page,
 * waits for the callback, exchanges the token, and returns credentials.
 */
export async function runBrowserLogin(opts: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeout_ms ?? 120_000;
  const state = randomBytes(16).toString("hex");

  return new Promise<BrowserLoginResult>((resolve, reject) => {
    let resolved = false;

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (resolved) {
        res.writeHead(200);
        res.end("Already processed.");
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const identityToken = url.searchParams.get("identity_token");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        res.writeHead(400);
        res.end("Invalid state — possible CSRF. Please retry login.");
        return;
      }

      if (!identityToken) {
        res.writeHead(400);
        res.end("Missing identity_token in callback.");
        return;
      }

      // Exchange the provider assertion at the engine.
      try {
        const exchangeRes = await fetchFn(`${opts.engine_url}/v1/identity/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "sk-cli/0.0.1" },
          body: JSON.stringify({
            provider_id: opts.provider_id,
            identity_token: identityToken,
          }),
        });

        if (!exchangeRes.ok) {
          const errBody = await exchangeRes.text();
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorPage("Token exchange failed", errBody));
          resolved = true;
          cleanup();
          reject(new Error(`token exchange failed: ${exchangeRes.status} ${errBody}`));
          return;
        }

        const data = (await exchangeRes.json()) as {
          api_key: string;
          user_id: string;
          tenant_id: string;
          email: string;
        };

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage(data.email));
        resolved = true;
        cleanup();
        resolve(data);
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage("Login failed", err instanceof Error ? err.message : String(err)));
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error("login timed out — no callback received"));
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    // Listen on requested port or random
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to start callback server"));
        return;
      }

      const callbackPort = addr.port;
      const loginUrl = new URL(opts.login_url);
      loginUrl.searchParams.set("identity_provider", opts.provider_id);
      loginUrl.searchParams.set("callback_port", String(callbackPort));
      loginUrl.searchParams.set("state", state);

      if (!opts.quiet) {
        process.stdout.write(`\n  Opening browser: ${loginUrl.toString()}\n`);
        process.stdout.write(
          `  Waiting for sign-in (${Math.round(timeoutMs / 1000)}s timeout)...\n\n`,
        );
      }

      // Open the browser
      openBrowser(loginUrl.toString());
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openBrowser(url: string): void {
  const { exec } = require("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

function successPage(email: string): string {
  const safe = escapeHtml(email);
  return `<!DOCTYPE html><html><head><title>Subkit — Signed In</title>
<style>body{font-family:system-ui;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;text-align:center;max-width:400px}
h1{color:#3fb950;font-size:24px}p{color:#8b949e;font-size:14px}</style></head>
<body><div class="card"><h1>Signed in</h1><p>${safe ? `Welcome, ${safe}` : "Authentication successful"}</p>
<p>You can close this tab and return to the terminal.</p></div></body></html>`;
}

function errorPage(title: string, detail: string): string {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  return `<!DOCTYPE html><html><head><title>Subkit — Error</title>
<style>body{font-family:system-ui;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;text-align:center;max-width:400px}
h1{color:#f85149;font-size:24px}p{color:#8b949e;font-size:14px}code{color:#f0883e}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p><code>${safeDetail}</code></p>
<p>Please return to the terminal and try again.</p></div></body></html>`;
}
