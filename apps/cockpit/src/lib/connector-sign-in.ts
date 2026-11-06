import type { components } from "@cli-core/engine-api/openapi";
import { ApiError } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";

type SignInRoute = NonNullable<components["schemas"]["Connector"]["sign_in"]>;

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function connectorSignIn(
  record: Readonly<Record<string, unknown>> | null | undefined,
): SignInRoute | null {
  const value = record?.sign_in;
  if (typeof value !== "object" || value === null) return null;
  const { kind, start } = value as Record<string, unknown>;
  if ((kind !== "oauth" && kind !== "mcp") || typeof start !== "string" || !start) return null;
  return { kind, start };
}

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  engine_public_url_missing: "signIn.failed.publicUrl",
  oauth_start_failed: "signIn.failed.service",
  mcp_authorization_failed: "signIn.failed.mcp",
};

export function signInFailure(failure: unknown, t: Translate): string {
  if (failure instanceof ApiError) {
    const key =
      failure.code && Object.hasOwn(FAILURES, failure.code) ? FAILURES[failure.code] : undefined;
    if (key) return t(key);
    if (failure.message) return t("signIn.failed.reason", { reason: failure.message });
  }
  return t("connectorCredentials.renewFailed");
}
