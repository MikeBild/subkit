import type { TestDb } from "../../../db/tests/setup.ts";
import { createOidcProvider } from "../oidc.ts";
import type { MockOidcHandle } from "./fixtures/mock-oidc.ts";

export const CLIENT_ID = "mock-client";

export const REDIRECT_URI = "http://127.0.0.1:0/v1/identity/login/callback";

export function oidcRealFixtures(state: {
  readonly testDb: TestDb;
  readonly mock: MockOidcHandle;
}) {
  function buildProvider(
    overrides: { enableSignup?: boolean; productId?: string; linkByEmail?: boolean } = {},
  ) {
    return createOidcProvider({
      db: state.testDb.db,
      issuerUrl: state.mock.url,
      clientId: CLIENT_ID,
      clientSecret: "mock-secret",
      redirectUri: REDIRECT_URI,
      tenantSlug: "oidc-real",
      enableSignup: overrides.enableSignup ?? true,
      ...(overrides.productId ? { productId: overrides.productId } : {}),
      ...(overrides.linkByEmail !== undefined ? { linkByEmail: overrides.linkByEmail } : {}),
    });
  }

  return { buildProvider };
}
