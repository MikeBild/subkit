import { createHash } from "node:crypto";
import { type Config, ConfigSchema } from "../../config/schema.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import type { McpOAuthProvider } from "./server-provider.ts";

export const REDIRECT_URI = "https://client.example.com/callback";

export const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function makeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function serverProviderFixtures(state: {
  readonly testDb: TestDb;
  readonly provider: McpOAuthProvider;
  readonly tenantId: string;
  readonly userId: string;
}) {
  function makeConfig(): Config {
    return ConfigSchema.parse({
      database: { url: state.testDb.url },
      server: {
        public_base_url: "https://test.example.com",
        port: 3000,
        host: "0.0.0.0",
      },
      auth: {
        mcp_oauth: {
          enabled: true,
          dynamic_registration_enabled: true,
          access_token_ttl_seconds: 3600,
          refresh_token_ttl_seconds: 2592000,
          authorization_code_ttl_seconds: 60,
          scopes_supported: ["mcp:read", "mcp:authoring", "mcp:admin"],
        },
      },
    });
  }

  const CODE_CHALLENGE = makeChallenge(CODE_VERIFIER);

  async function registerTestClient(opts?: {
    redirect_uris?: string[];
    scope?: string;
  }): Promise<string> {
    const result = await state.provider.registerClient({
      redirect_uris: opts?.redirect_uris ?? [REDIRECT_URI],
      client_name: "Test Client",
      scope: opts?.scope ?? "mcp:read",
    });
    return result.client_id;
  }

  async function issueTokenPair(opts?: {
    clientId?: string;
    scope?: string;
    verifier?: string;
    challenge?: string;
    resource?: string;
  }): Promise<{
    access_token: string;
    refresh_token: string;
    token_type: "bearer";
    expires_in: number;
    scope: string;
  }> {
    const clientId =
      opts?.clientId ??
      (await registerTestClient(opts?.scope !== undefined ? { scope: opts.scope } : undefined));
    const verifier = opts?.verifier ?? CODE_VERIFIER;
    const challenge = opts?.challenge ?? CODE_CHALLENGE;

    const code = await state.provider.issueAuthorizationCode({
      clientId,
      tenantId: state.tenantId,
      userId: state.userId,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      scope: opts?.scope ?? "mcp:read",
      ...(opts?.resource ? { resource: opts.resource } : {}),
    });

    return state.provider.exchangeAuthorizationCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT_URI,
      clientId,
    });
  }

  return { CODE_CHALLENGE, issueTokenPair, makeConfig, registerTestClient };
}
