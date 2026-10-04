import { ApiError } from "@/api/client";
import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

/**
 * How a connector is signed in with an account, as the engine states it on
 * the connector: the POST that answers `{ authorization_url }`. A web service
 * and an MCP server sign in on different routes; the page starts the one the
 * connector names instead of choosing by driver.
 */
export type SignInRoute = NonNullable<components["schemas"]["Connector"]["sign_in"]>;

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** The connector's own sign-in, or null when it has none to start in a browser. */
export function connectorSignIn(
  record: Readonly<Record<string, unknown>> | null | undefined,
): SignInRoute | null {
  const value = record?.sign_in;
  if (typeof value !== "object" || value === null) return null;
  const { kind, start } = value as Record<string, unknown>;
  if ((kind !== "oauth" && kind !== "mcp") || typeof start !== "string" || !start) return null;
  return { kind, start };
}

// The engine's named reasons a sign-in cannot start, each a short line the
// reader can act on. Anything else is said in the engine's own words.
const FAILURES: Readonly<Record<string, TranslationKey>> = {
  engine_public_url_missing: "signIn.failed.publicUrl",
  oauth_start_failed: "signIn.failed.service",
  mcp_authorization_failed: "signIn.failed.mcp",
};

/** Why the sign-in did not start, in one line. */
export function signInFailure(failure: unknown, t: Translate): string {
  if (failure instanceof ApiError) {
    const key =
      failure.code && Object.hasOwn(FAILURES, failure.code) ? FAILURES[failure.code] : undefined;
    if (key) return t(key);
    if (failure.message) return t("signIn.failed.reason", { reason: failure.message });
  }
  return t("connectorCredentials.renewFailed");
}
