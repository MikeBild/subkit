// OIDC device-authorization flow shared by `sk login` and any packaged
// CLI compatibility aliases.
//
// The function is pure / testable: a caller can inject a custom fetch,
// a scope, and a polling-interval override. It never touches process.
// stdout when `quiet: true` — the CLI-level command wrappers own the
// human-facing prompts.

import * as oauth from "openid-client";
import pc from "picocolors";

export interface DeviceFlowOptions {
  issuer_url: string;
  client_id: string;
  engine_url: string;
  scope?: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Suppress prompt UI in tests. */
  quiet?: boolean;
  /** Override the `interval` advertised by the IdP (seconds). */
  pollIntervalOverrideSeconds?: number;
}

export interface DeviceFlowResult {
  api_key: string;
  user_id: string;
  tenant_id: string;
  sub: string;
}

const DEFAULT_SCOPE = "openid profile email offline_access";

export async function runDeviceFlow(opts: DeviceFlowOptions): Promise<DeviceFlowResult> {
  const issuerUrl = new URL(opts.issuer_url);
  // Allow http:// for local mock servers (tests + dev IdP).
  const discoveryOptions: oauth.DiscoveryRequestOptions =
    issuerUrl.protocol === "http:" ? { execute: [oauth.allowInsecureRequests] } : {};
  const config = await oauth.discovery(
    issuerUrl,
    opts.client_id,
    undefined,
    undefined,
    discoveryOptions,
  );
  if (issuerUrl.protocol === "http:") {
    oauth.allowInsecureRequests(config);
  }

  const initiated = await oauth.initiateDeviceAuthorization(config, {
    scope: opts.scope ?? DEFAULT_SCOPE,
  });

  if (!opts.quiet) {
    const lines = [
      "",
      pc.bold(pc.cyan("To finish signing in:")),
      `  1. Open ${pc.bold(pc.underline(initiated.verification_uri))} in your browser`,
      `  2. Enter the code: ${pc.bold(pc.yellow(initiated.user_code))}`,
      "",
      pc.dim(`(this code expires in ${initiated.expires_in} seconds)`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    if (initiated.verification_uri_complete) {
      process.stdout.write(pc.dim(`  shortcut: ${initiated.verification_uri_complete}\n`));
    }
  }

  const tokens = await oauth.pollDeviceAuthorizationGrant(config, initiated);
  const id_token = (tokens as { id_token?: string }).id_token;
  if (!id_token) {
    throw new Error("device flow returned no id_token");
  }

  // Exchange id_token for a personal API key minted by the engine.
  const fetchImpl = opts.fetchImpl ?? fetch;
  const exchangeRes = await fetchImpl(
    `${opts.engine_url.replace(/\/$/, "")}/v1/identity/sessions/oidc`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token, issuer: issuerUrl.toString() }),
    },
  );
  if (!exchangeRes.ok) {
    const text = await exchangeRes.text().catch(() => "");
    throw new Error(`engine exchange failed: ${exchangeRes.status} ${text}`);
  }
  const json = (await exchangeRes.json()) as DeviceFlowResult;
  if (!json.api_key) throw new Error("engine returned no api_key");
  return json;
}
