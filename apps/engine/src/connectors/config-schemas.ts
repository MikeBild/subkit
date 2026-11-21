import { z } from "zod";
import { SignedJwtConfigSchema } from "../credentials/signed-jwt.ts";
import { type McpAuthConfig, McpAuthConfigSchema } from "../mcp/client/registry.ts";
import { type AuthType, type DriverName, HttpConnectorConfig } from "./types.ts";

const GraphQLConnectorConfigSchema = z.object({
  default_headers: z.record(z.string(), z.string()).optional(),
  signed_jwt: SignedJwtConfigSchema.optional(),
});

const S3ConnectorConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1).optional(),
  endpoint: z.string().optional(),
  force_path_style: z.boolean().optional(),
});

const PostgresConnectorConfigSchema = z.object({});

const DeviceConnectorConfigSchema = z.object({ device_id: z.string().uuid() }).strict();

export const McpConnectorConfigSchema = z
  .object({
    mcp: z
      .object({
        transport: z.enum(["http", "sse"]).default("http"),
        auth: McpAuthConfigSchema.optional(),
        remote_tool_call_timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
        tools_without_confirmation: z.array(z.string().min(1).max(256)).max(512).optional(),
      })
      .strict(),
  })
  .strict();

export const CONNECTOR_CONFIG_SCHEMAS: Record<DriverName, z.ZodType> = {
  http: HttpConnectorConfig,
  graphql: GraphQLConnectorConfigSchema,
  s3: S3ConnectorConfigSchema,
  postgres: PostgresConnectorConfigSchema,
  mcp: McpConnectorConfigSchema,
  local_files: DeviceConnectorConfigSchema,
  local_browser: DeviceConnectorConfigSchema,
  local_computer: DeviceConnectorConfigSchema,
};

export const MCP_ONLY_AUTH_TYPES: readonly AuthType[] = ["oauth2_client", "oauth2_private_key"];

const MCP_AUTH_KIND_BY_TYPE: Readonly<Partial<Record<AuthType, McpAuthConfig["kind"]>>> = {
  none: "none",
  bearer: "bearer",
  basic: "basic",
  header: "header",
  oauth2: "oauth2",
  oauth2_client: "oauth2_client_credentials",
  oauth2_private_key: "oauth2_private_key_jwt",
};

export function mcpAuthKindForType(auth_type: AuthType): McpAuthConfig["kind"] | null {
  return MCP_AUTH_KIND_BY_TYPE[auth_type] ?? null;
}

export function withMcpConfigDefaults(
  driver: DriverName,
  auth_type: AuthType,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (driver !== "mcp") return { ...(config ?? {}) };
  const expectedKind = mcpAuthKindForType(auth_type);
  if (
    config &&
    Object.hasOwn(config, "mcp") &&
    (typeof config.mcp !== "object" || config.mcp === null || Array.isArray(config.mcp))
  ) {
    return { ...config };
  }
  const existingMcp =
    config?.mcp && typeof config.mcp === "object" ? (config.mcp as Record<string, unknown>) : {};
  return {
    ...(config ?? {}),
    mcp: {
      ...existingMcp,
      ...(existingMcp.transport === undefined ? { transport: "http" } : {}),
      ...(existingMcp.auth === undefined && expectedKind ? { auth: { kind: expectedKind } } : {}),
    },
  };
}

interface ConnectorConfigIssue {
  path: string;
  message: string;
}

export function validateConnectorAuthType(
  driver: DriverName,
  auth_type: AuthType | undefined | null,
): ConnectorConfigIssue[] {
  if (!auth_type) return [];
  if (driver === "mcp") {
    if (mcpAuthKindForType(auth_type)) return [];
    return [
      {
        path: "auth_type",
        message: `auth_type '${auth_type}' is not supported by the mcp transport — use none, bearer, basic, header, oauth2, oauth2_client, or oauth2_private_key`,
      },
    ];
  }
  if (auth_type === "signed_jwt") {
    if (driver === "http" || driver === "graphql") return [];
    return [
      {
        path: "auth_type",
        message: "auth_type 'signed_jwt' is supported only by http and graphql connectors",
      },
    ];
  }
  if (!MCP_ONLY_AUTH_TYPES.includes(auth_type)) return [];
  return [
    {
      path: "auth_type",
      message: `auth_type '${auth_type}' is only declarable by an mcp connector — it identifies an OAuth2 client to a token endpoint and is never applied to a ${driver} request`,
    },
  ];
}

export function validateSignedJwtAuthConfig(
  auth_type: AuthType | undefined | null,
  config: Record<string, unknown> | undefined | null,
): ConnectorConfigIssue[] {
  if (auth_type !== "signed_jwt") return [];
  const issues: ConnectorConfigIssue[] = [];
  const signed = SignedJwtConfigSchema.safeParse(config?.signed_jwt);
  if (!signed.success) {
    for (const issue of signed.error.issues) {
      issues.push({
        path: `config.signed_jwt${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}`,
        message: issue.message,
      });
    }
  }
  if (config?.oauth !== undefined) {
    issues.push({
      path: "config.oauth",
      message: "signed_jwt authentication does not use OAuth token exchange configuration",
    });
  }
  return issues;
}

export function validateMcpAuthConsistency(
  driver: DriverName,
  auth_type: AuthType | undefined | null,
  config: Record<string, unknown> | undefined | null,
): ConnectorConfigIssue[] {
  if (driver !== "mcp" || !auth_type) return [];
  const expected = mcpAuthKindForType(auth_type);
  if (!expected) return [];
  const block = config?.mcp;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return [{ path: "config.mcp", message: "config.mcp is required for an mcp connector" }];
  }
  const auth = (block as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return [
      {
        path: "config.mcp.auth.kind",
        message: `config.mcp.auth.kind must be '${expected}' for auth_type '${auth_type}'`,
      },
    ];
  }
  const actual = (auth as Record<string, unknown>).kind;
  return actual === expected
    ? []
    : [
        {
          path: "config.mcp.auth.kind",
          message: `config.mcp.auth.kind '${String(actual)}' does not match auth_type '${auth_type}' (expected '${expected}')`,
        },
      ];
}

export function validateConnectorConfig(
  driver: DriverName,
  config: Record<string, unknown> | undefined | null,
): ConnectorConfigIssue[] {
  if (!config) return [];
  const schema = CONNECTOR_CONFIG_SCHEMAS[driver];
  if (!schema) return [{ path: "driver", message: `no config schema for driver '${driver}'` }];
  const parsed = schema.safeParse(config);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "config";
    const headerKey =
      driver === "mcp" &&
      path === "mcp.auth" &&
      i.code === "unrecognized_keys" &&
      i.keys.some((key) => /header/i.test(key));
    return {
      path,
      message: headerKey
        ? `${i.message} — config.mcp.auth carries no header name. For auth_type "header" the name travels with the credential: collect header_name (pre-filled, not sensitive) and header_value (sensitive) with ask_user_form, and keep config.mcp.auth to { kind: "header" }`
        : i.message,
    };
  });
}

export function validateConnectorConfigOrThrow(
  driver: DriverName,
  config: Record<string, unknown> | undefined | null,
): void {
  const issues = validateConnectorConfig(driver, config);
  if (issues.length === 0) return;
  throw Object.assign(new Error(`invalid ${driver} connector config`), {
    code: "connector_config_invalid",
    details: issues.map((i) => `${i.path}: ${i.message}`),
  });
}

export function connectorConfigIssues(err: unknown): string[] | null {
  if (!(err instanceof Error)) return null;
  const tagged = err as Error & { code?: unknown; details?: unknown };
  if (tagged.code !== "connector_config_invalid") return null;
  return Array.isArray(tagged.details)
    ? tagged.details.filter((detail): detail is string => typeof detail === "string")
    : [];
}
