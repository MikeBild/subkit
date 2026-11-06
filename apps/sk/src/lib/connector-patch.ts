import type { components } from "@cli-core/engine-api/openapi.d.ts";

type Schemas = components["schemas"];
type Connector = Schemas["Connector"];
type CreateConnectorBody = Schemas["CreateConnectorBody"];
type UpdateConnectorBody = Schemas["UpdateConnectorBody"];
type Json = Record<string, unknown>;

type ConnectorDraftSource = Pick<
  Connector,
  "display_name" | "slug" | "driver" | "environment" | "auth_type" | "base_url" | "dsn" | "config"
>;

const DRIVERS = [
  "http",
  "postgres",
  "s3",
  "graphql",
  "mcp",
] as const satisfies readonly CreateConnectorBody["driver"][];

const ENVIRONMENTS = [
  "dev",
  "prod",
] as const satisfies readonly CreateConnectorBody["environment"][];

const AUTH_TYPES = [
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "oauth2_client",
  "oauth2_private_key",
  "signed_jwt",
  "aws_sigv4",
] as const satisfies readonly CreateConnectorBody["auth_type"][];

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function accepted<T extends string>(list: readonly T[], value: string, field: string): T {
  const found = list.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`connector ${field} '${value}' is not one the engine accepts`);
  }
  return found;
}

function mergeRecord(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergeConnectorConfig(base[key], value) : value;
  }
  return out;
}

export function mergeConnectorConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  return mergeRecord(base, patch);
}

export function connectorPatchBody(
  current: Pick<Connector, "config">,
  file: UpdateConnectorBody,
): UpdateConnectorBody {
  if (!isPlainObject(file.config)) return file;
  return {
    ...file,
    config: isPlainObject(current.config) ? mergeRecord(current.config, file.config) : file.config,
  };
}

export function connectorPatchDraft(
  current: ConnectorDraftSource,
  patch: UpdateConnectorBody,
): CreateConnectorBody {
  const baseUrl = patch.base_url ?? current.base_url;
  const dsn = patch.dsn ?? current.dsn;
  return {
    name: patch.name ?? (current.display_name || current.slug),
    driver: accepted(DRIVERS, current.driver, "driver"),
    environment: accepted(ENVIRONMENTS, current.environment, "environment"),
    auth_type: patch.auth_type ?? accepted(AUTH_TYPES, current.auth_type, "auth_type"),
    config: patch.config ?? current.config,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(dsn ? { dsn } : {}),
  };
}

export function connectorDisplayName(
  current: Pick<Connector, "display_name" | "slug" | "id">,
): string {
  return current.display_name || current.slug || current.id;
}
