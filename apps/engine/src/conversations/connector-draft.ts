import type { CreateConnectorInput } from "../connectors/types.ts";
import type { ConnectorDraftDocument } from "./types.ts";

export interface ConnectorDraftValidation {
  ok: boolean;
  missing_fields: string[];
  errors: Array<{ path: string; message: string }>;
}

function pushError(
  errors: Array<{ path: string; message: string }>,
  path: string,
  message: string,
): void {
  errors.push({ path, message });
}

export function validateConnectorDraft(
  connector: ConnectorDraftDocument | null,
): ConnectorDraftValidation {
  const missing_fields: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!connector) {
    return {
      ok: false,
      missing_fields: ["connector"],
      errors: [{ path: "connector", message: "start a connector draft first" }],
    };
  }
  if (!connector.name) missing_fields.push("name");
  if (!connector.driver) missing_fields.push("driver");
  if (!connector.environment) missing_fields.push("environment");
  if (!connector.auth_type) missing_fields.push("auth_type");

  if (connector.driver === "http" || connector.driver === "graphql" || connector.driver === "s3") {
    if (!connector.base_url) missing_fields.push("base_url");
    else {
      try {
        new URL(connector.base_url);
      } catch {
        pushError(errors, "base_url", "base_url must be a valid URL");
      }
    }
  }
  if (connector.driver === "postgres") {
    if (!connector.dsn) missing_fields.push("dsn");
    else if (
      !connector.dsn.startsWith("postgres://") &&
      !connector.dsn.startsWith("postgresql://")
    ) {
      pushError(errors, "dsn", "dsn must start with postgres:// or postgresql://");
    }
  }
  if (connector.slug && !/^[a-z0-9][a-z0-9-]*$/u.test(connector.slug)) {
    pushError(errors, "slug", "slug must match /^[a-z0-9][a-z0-9-]*$/");
  }
  return {
    ok: missing_fields.length === 0 && errors.length === 0,
    missing_fields,
    errors,
  };
}

export function toCreateConnectorInput(connector: ConnectorDraftDocument): CreateConnectorInput {
  return {
    name: connector.name ?? "untitled-connector",
    ...(connector.slug ? { slug: connector.slug } : {}),
    driver: connector.driver ?? "http",
    environment: connector.environment ?? "dev",
    ...(connector.base_url ? { base_url: connector.base_url } : {}),
    ...(connector.dsn ? { dsn: connector.dsn } : {}),
    auth_type: connector.auth_type ?? "none",
    ...(connector.config ? { config: connector.config } : {}),
  };
}
