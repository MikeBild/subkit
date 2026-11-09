import { SignedJwtConfigSchema } from "../../credentials/core/signed-jwt-config.ts";

type DriverName = "http" | "postgres" | "s3" | "graphql" | "mcp";
type AuthType =
  | "none"
  | "header"
  | "query"
  | "bearer"
  | "basic"
  | "oauth2"
  | "oauth2_client"
  | "oauth2_private_key"
  | "signed_jwt"
  | "aws_sigv4";

export interface ConnectorConfigIssue {
  readonly path: string;
  readonly message: string;
}

const MCP_ONLY_AUTH_TYPES: readonly AuthType[] = ["oauth2_client", "oauth2_private_key"];

const MCP_AUTH_KIND_BY_TYPE: Readonly<
  Partial<
    Record<
      AuthType,
      | "none"
      | "bearer"
      | "basic"
      | "header"
      | "oauth2"
      | "oauth2_client_credentials"
      | "oauth2_private_key_jwt"
    >
  >
> = {
  none: "none",
  bearer: "bearer",
  basic: "basic",
  header: "header",
  oauth2: "oauth2",
  oauth2_client: "oauth2_client_credentials",
  oauth2_private_key: "oauth2_private_key_jwt",
};

function mcpAuthKindForType(auth_type: AuthType) {
  return MCP_AUTH_KIND_BY_TYPE[auth_type] ?? null;
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
