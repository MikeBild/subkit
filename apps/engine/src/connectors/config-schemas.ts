// Per-driver validation of the connector fields whose meaning depends on the
// driver: `config` and `auth_type`.
//
// One place that answers "is this valid for this driver?", so the answer
// is the same whether it is asked by a write, by `POST /v1/connectors/validate`,
// or by the CLI before it saves anything.
//
// WHY THIS EXISTS. Only HTTP was ever validated on write; graphql and s3 parsed
// their config ad hoc inside the driver, at call time. So a config with a typo'd
// or missing key was accepted, stored, and only failed when someone actually ran
// a step through it — with an error naming the connector id rather than the field.
// An author who cannot see a mistake until runtime cannot fix it while authoring.
//
// STRICTNESS IS PER DRIVER, ON PURPOSE:
//   - http is `.strict()` and always has been. Unknown keys are rejected.
//   - graphql / s3 / postgres accept unknown keys. Their drivers have always
//     ignored anything they did not read, so rejecting extra keys here would
//     turn configs that work today into write errors. This validates the keys
//     the driver actually consumes, and leaves the rest alone.
//   - mcp is `.strict()`. The leniency above is a compatibility debt owed to
//     configs written before this file existed; mcp has none, so it starts
//     closed. Do not copy the lenient pattern into the next driver by analogy.
//
// Adding a driver: add its entry to CONNECTOR_CONFIG_SCHEMAS. A driver with no
// config keys still gets an entry — `postgres` is configured through `dsn`, and
// saying so explicitly is what stops the next reader from assuming an omission.

import { z } from "zod";
import { type McpAuthConfig, McpAuthConfigSchema } from "../mcp/client/registry.ts";
import { type AuthType, type DriverName, HttpConnectorConfig } from "./types.ts";

/** GraphQL: the endpoint is `base_url` (a GraphQL API has exactly one), so the
 *  only config the driver reads is the per-request header set. */
export const GraphQLConnectorConfigSchema = z.object({
  default_headers: z.record(z.string(), z.string()).optional(),
});

/** S3: `bucket` is required because the driver cannot address anything without
 *  it — omitting it produced a connector that threw on first use. Requiring it
 *  at write time turns a runtime failure into an authoring-time message. */
export const S3ConnectorConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1).optional(),
  endpoint: z.string().optional(),
  force_path_style: z.boolean().optional(),
});

/** Postgres reads nothing from `config`; the connection is `dsn`. */
export const PostgresConnectorConfigSchema = z.object({});

/**
 * MCP: the remote endpoint is `base_url`; everything the pool needs beyond it
 * lives under `config.mcp`.
 *
 * `transport` deliberately omits `stdio`. The pool throws on it (a local
 * subprocess has no sandbox and no per-tenant filesystem on a hosted engine),
 * and encoding that refusal here turns a handshake-time throw into an
 * authoring-time message — which is the whole point of this file. `sse` is
 * accepted only because rows carrying it already exist; the migration lands
 * them disabled with `health_error_code = mcp_transport_unsupported`, and this
 * schema must not make those rows unpatchable.
 *
 * The auth block is the SAME schema the registry parses, imported rather than
 * restated: two copies of a six-kind discriminator drift, and the one that
 * drifts is whichever is not the one the pool reads.
 *
 * NOT here, on purpose: roots, sampling and logging-notification settings. The
 * current spec RC deprecates the first two and no code in this repo serves any
 * of them, so a config leaf for them would be a promise the engine does not
 * keep. Neither is there a per-connector private-host allowlist: the egress
 * guard is what stands between a tenant-supplied URL and the metadata service,
 * and a config key that punches through it would be a hole with an audit trail
 * rather than a setting.
 */
export const McpConnectorConfigSchema = z
  .object({
    mcp: z
      .object({
        transport: z.enum(["http", "sse"]).default("http"),
        auth: McpAuthConfigSchema.optional(),
        /** Per-connector override of `connectors.mcp.remote_tool_call_timeout_ms`.
         *  Bounded because this timeout is what stops a hung remote from
         *  holding the conversation's tool mutex for the whole turn. */
        remote_tool_call_timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
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
};

/**
 * The auth kinds only an `mcp` connector may declare.
 *
 * Both are machine-to-machine OAuth2 flows that the MCP client pool consumes
 * when it opens a session — they are client IDENTITY, not applicable auth. The
 * HTTP driver's `applyCredential` throws on either rather than sign a request
 * with one, so an http / graphql / s3 / postgres connector declaring one is a
 * connector that cannot complete a single call.
 *
 * `AuthTypeEnum` is one enum shared by every driver, which is what made the
 * widening advertise these two to every driver in the generated contract. This
 * list is the narrowing, applied on write; the enum's OpenAPI description says
 * the same thing where a client reads it.
 */
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

/** Seed only absent MCP fields; explicit values remain validation inputs. */
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

export interface ConnectorConfigIssue {
  /** Dotted path to the offending key, `"config"` when the whole value is wrong. */
  path: string;
  message: string;
}

/**
 * Is this `auth_type` declarable by this driver?
 *
 * Returns issues in the same shape as `validateConnectorConfig` so the validate
 * endpoint can concatenate the two lists and report every problem at once.
 */
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
  if (!MCP_ONLY_AUTH_TYPES.includes(auth_type)) return [];
  return [
    {
      path: "auth_type",
      message: `auth_type '${auth_type}' is only declarable by an mcp connector — it identifies an OAuth2 client to a token endpoint and is never applied to a ${driver} request`,
    },
  ];
}

/** Keep the credential mode aligned with the MCP transport auth strategy. */
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

/**
 * Validate a connector config against its driver.
 *
 * Returns the issues rather than throwing, so a caller that wants to report
 * every problem at once (validate endpoint, CLI) does not have to fish them out
 * of an exception. `validateConnectorConfigOrThrow` is the write-path wrapper.
 *
 * An absent config is valid for every driver: `config` is optional on create,
 * and a patch that does not mention it leaves the stored value untouched.
 */
export function validateConnectorConfig(
  driver: DriverName,
  config: Record<string, unknown> | undefined | null,
): ConnectorConfigIssue[] {
  if (!config) return [];
  const schema = CONNECTOR_CONFIG_SCHEMAS[driver];
  // An unknown driver reaching this point means DriverEnum and this registry
  // have drifted. Say so rather than silently accepting anything.
  if (!schema) return [{ path: "driver", message: `no config schema for driver '${driver}'` }];
  const parsed = schema.safeParse(config);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "config";
    // A header name written into the MCP auth block is the one mistake the
    // bare "Unrecognized key" leaves unanswerable: say where it belongs.
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

/** Write-path wrapper: throws the `connector_config_invalid` error the HTTP
 *  layer already maps to a 400 with a `details` list. */
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
