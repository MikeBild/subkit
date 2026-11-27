import { posix, win32 } from "node:path";
import { z } from "zod";
import { SignedJwtConfigSchema } from "../credentials/signed-jwt.ts";
import { type McpAuthConfig, McpAuthConfigSchema } from "../mcp/client/registry.ts";
import { SftpAuthConfigSchema } from "./core/sftp-auth.ts";
import { ProbeEndpointSchema } from "./templates.ts";
import {
  type AuthType,
  type DriverName,
  HttpConnectorConfig,
  LocalTlsConfigSchema,
} from "./types.ts";

const GraphQLConnectorConfigSchema = z.object({
  tls: LocalTlsConfigSchema.optional(),
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

const SftpConnectorConfigSchema = z
  .object({
    host_key_sha256: z
      .string()
      .regex(
        /^(SHA256:)?[A-Za-z0-9+/]{43}=?$/,
        "host_key_sha256 must be a SHA256 host key fingerprint",
      ),
    auth: SftpAuthConfigSchema.optional(),
  })
  .strict();

const DeviceConnectorConfigSchema = z.object({ device_id: z.string().uuid() }).strict();

const STDIO_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const STDIO_ONLY_FIELDS = [
  "command",
  "args",
  "env",
  "env_secret_names",
  "cwd",
  "confirmed_command_hash",
  "confirmed_by",
  "confirmed_at",
  "command_set_by",
] as const;

function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

export const McpConnectorConfigSchema = z
  .object({
    mcp: z
      .object({
        transport: z.enum(["http", "sse", "stdio"]).default("http"),
        auth: McpAuthConfigSchema.optional(),
        remote_tool_call_timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
        tools_without_confirmation: z.array(z.string().min(1).max(256)).max(512).optional(),
        tls: z
          .object({
            ca_pem: z
              .string()
              .max(65_536)
              .regex(/-----BEGIN CERTIFICATE-----/, "ca_pem must be a PEM certificate")
              .optional(),
            skip_verify: z.boolean().optional(),
          })
          .strict()
          .optional(),
        command: z.string().min(1).max(1024).optional(),
        args: z.array(z.string().max(4096)).max(64).optional(),
        env: z
          .record(
            z.string().regex(STDIO_ENV_NAME_RE, "env names must match [A-Za-z_][A-Za-z0-9_]*"),
            z.string().max(4096),
          )
          .refine((env) => Object.keys(env).length <= 64, "env takes at most 64 entries")
          .optional(),
        env_secret_names: z
          .array(z.string().regex(STDIO_ENV_NAME_RE, "env names must match [A-Za-z_][A-Za-z0-9_]*"))
          .max(64)
          .optional(),
        cwd: z.string().max(4096).refine(isAbsolutePath, "cwd must be an absolute path").optional(),
        confirmed_command_hash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        confirmed_by: z.string().min(1).max(256).optional(),
        confirmed_at: z.string().datetime().optional(),
        command_set_by: z.string().min(1).max(256).optional(),
      })
      .strict()
      .superRefine((block, ctx) => {
        if (block.transport === "stdio") {
          if (!block.command) {
            ctx.addIssue({
              code: "custom",
              path: ["command"],
              message: "a stdio MCP server needs command — the program the engine starts",
            });
          }
          if (block.tls) {
            ctx.addIssue({
              code: "custom",
              path: ["tls"],
              message:
                "tls applies to http and sse MCP servers only; a stdio server has no address",
            });
          }
          const names = new Set(Object.keys(block.env ?? {}));
          const secret = block.env_secret_names ?? [];
          if (new Set(secret).size !== secret.length) {
            ctx.addIssue({
              code: "custom",
              path: ["env_secret_names"],
              message: "env_secret_names lists a name twice",
            });
          }
          for (const name of secret) {
            if (names.has(name)) {
              ctx.addIssue({
                code: "custom",
                path: ["env_secret_names"],
                message: `env '${name}' is declared both as a plain value and as a secret; keep it in one place`,
              });
            }
          }
          return;
        }
        for (const field of STDIO_ONLY_FIELDS) {
          if (block[field] !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: `${field} applies to stdio MCP servers only; set transport to "stdio" or remove it`,
            });
          }
        }
      }),
  })
  .strict();

export const CONNECTOR_CONFIG_SCHEMAS: Record<DriverName, z.ZodType> = {
  http: HttpConnectorConfig,
  graphql: GraphQLConnectorConfigSchema,
  s3: S3ConnectorConfigSchema,
  sftp: SftpConnectorConfigSchema,
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
  const probeIssues = driver === "http" ? validateHttpProbeEndpoint(config.probe_endpoint) : [];
  if (parsed.success) return probeIssues;
  const configIssues = parsed.error.issues.map((i) => {
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
  return [...configIssues, ...probeIssues];
}

function validateHttpProbeEndpoint(probeEndpoint: unknown): ConnectorConfigIssue[] {
  if (!probeEndpoint || typeof probeEndpoint !== "object" || Array.isArray(probeEndpoint))
    return [];
  const parsed = ProbeEndpointSchema.safeParse(probeEndpoint);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: ["probe_endpoint", ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
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
