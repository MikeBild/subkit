import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const DRIVER_KEYS: Record<string, TranslationKey> = {
  http: "connectorLabel.driver.http",
  graphql: "connectorLabel.driver.graphql",
  mcp: "connectorLabel.driver.mcp",
  postgres: "connectorLabel.driver.postgres",
  s3: "connectorLabel.driver.s3",
};

const TRANSPORT_KEYS: Record<string, TranslationKey> = {
  http: "connectorLabel.transport.http",
  sse: "connectorLabel.transport.sse",
  stdio: "connectorLabel.transport.stdio",
};

const ENVIRONMENT_KEYS: Record<string, TranslationKey> = {
  prod: "connectorLabel.environment.prod",
  dev: "connectorLabel.environment.dev",
};

const AUTH_KEYS: Record<string, TranslationKey> = {
  none: "connectorLabel.auth.none",
  header: "connectorLabel.auth.header",
  query: "connectorLabel.auth.query",
  bearer: "connectorLabel.auth.bearer",
  basic: "connectorLabel.auth.basic",
  oauth2: "connectorLabel.auth.oauth2",
  oauth2_client: "connectorLabel.auth.oauth2_client",
  oauth2_private_key: "connectorLabel.auth.oauth2_private_key",
  signed_jwt: "connectorLabel.auth.signed_jwt",
  aws_sigv4: "connectorLabel.auth.aws_sigv4",
};

function mapped(map: Record<string, TranslationKey>, raw: string | null, t: Translate): string {
  if (raw === null || raw === "") return "";
  const key = map[raw];
  return key ? t(key) : t("connectorLabel.other", { raw });
}

export function driverLabel(raw: string | null, t: Translate): string {
  return mapped(DRIVER_KEYS, raw, t);
}

export function transportLabel(raw: string | null, t: Translate): string {
  return mapped(TRANSPORT_KEYS, raw, t);
}

export function environmentLabel(raw: string | null, t: Translate): string {
  return mapped(ENVIRONMENT_KEYS, raw, t);
}

export function authLabel(
  authType: string | null,
  headerNames: readonly string[],
  t: Translate,
): string {
  if (authType === "header") {
    return headerNames.length > 0
      ? t("connectorLabel.auth.header", { name: headerNames.join(", ") })
      : t("connectorLabel.auth.headerUnnamed");
  }
  return mapped(AUTH_KEYS, authType, t);
}
