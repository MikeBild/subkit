import type { components } from "@cli-core/engine-api/openapi.d.ts";

type Schemas = components["schemas"];
type Connector = Schemas["Connector"];
type CreateConnectorBody = Schemas["CreateConnectorBody"];
type Json = Record<string, unknown>;

type ConnectorDraftSource = Pick<
  Connector,
  "display_name" | "slug" | "driver" | "environment" | "auth_type" | "base_url" | "dsn" | "config"
>;

type ConnectorDraft = Pick<CreateConnectorBody, "base_url" | "dsn"> & {
  name?: unknown;
  driver: string;
  environment: string;
  auth_type?: unknown;
  config?: unknown;
};

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function mergeConnectorConfig(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergeConnectorConfig(base[key], value) : value;
  }
  return out;
}

export function unwrapConnectorRecord<T extends Pick<Connector, "id">>(record: T): T {
  return record;
}

export function connectorPatchBody(current: Pick<Connector, "config">, file: Json): Json {
  if (!isPlainObject(file.config)) return file;
  return { ...file, config: mergeConnectorConfig(current.config, file.config) };
}

export function connectorPatchDraft(current: ConnectorDraftSource, patch: Json): ConnectorDraft {
  const name = patch.name !== undefined ? patch.name : current.display_name || current.slug;
  const authType = patch.auth_type !== undefined ? patch.auth_type : current.auth_type;
  const config = patch.config !== undefined ? patch.config : current.config;
  const baseUrl = patch.base_url !== undefined ? patch.base_url : current.base_url;
  const dsn = patch.dsn !== undefined ? patch.dsn : current.dsn;
  return {
    ...(name != null ? { name } : {}),
    driver: current.driver,
    environment: current.environment,
    ...(authType != null ? { auth_type: authType } : {}),
    ...(config != null ? { config } : {}),
    ...(typeof baseUrl === "string" && baseUrl ? { base_url: baseUrl } : {}),
    ...(typeof dsn === "string" && dsn ? { dsn } : {}),
  };
}

export function connectorDisplayName(
  current: Pick<Connector, "display_name" | "slug" | "id">,
): string {
  return current.display_name || current.slug || current.id;
}
