import { isStdioMcpConfig, stdioSpecFromConfig } from "@shared/stdio-identity.ts";
import { classifyLocalHost, classifyLocalTarget } from "./local-egress.ts";
import type { AuthType, DriverName } from "./types.ts";

export interface LocalConnectorIssue {
  path: string;
  message: string;
}

export interface LocalConnectorShape {
  driver: DriverName;
  auth_type: AuthType;
  base_url: string | null | undefined;
  dsn: string | null | undefined;
  config: Record<string, unknown> | null | undefined;
}

const TLS_LOCAL_ONLY =
  "tls (own CA or skipping verification) applies to local addresses only — localhost, 127.0.0.1, ::1 or host.docker.internal; a remote server must present a publicly trusted certificate";

const STDIO_AUTH_TYPES: ReadonlySet<AuthType> = new Set<AuthType>(["none", "header"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hostIsLocal(address: string | null | undefined): boolean {
  if (!address) return false;
  if (classifyLocalTarget(address) !== null) return true;
  try {
    return classifyLocalHost(new URL(address).hostname) !== null;
  } catch {
    return false;
  }
}

function connectorTargetIsLocal(shape: LocalConnectorShape): boolean {
  if (shape.driver === "postgres") return hostIsLocal(shape.dsn) || hostIsLocal(shape.base_url);
  if (shape.driver === "s3") {
    const endpoint = record(shape.config)?.endpoint;
    return hostIsLocal(typeof endpoint === "string" ? endpoint : null);
  }
  return hostIsLocal(shape.base_url);
}

function stdioIssue(shape: LocalConnectorShape): LocalConnectorIssue | null {
  if (shape.base_url) {
    return {
      path: "base_url",
      message:
        "a stdio MCP server has no address — leave base_url empty and set config.mcp.command",
    };
  }
  if (!STDIO_AUTH_TYPES.has(shape.auth_type)) {
    return {
      path: "auth_type",
      message: `a stdio MCP server signs in through its environment, not with '${shape.auth_type}'; use auth_type "none", or "header" when env_secret_names carry secret values`,
    };
  }
  const spec = stdioSpecFromConfig(shape.config);
  if (spec && spec.env_secret_names.length > 0 && shape.auth_type !== "header") {
    return {
      path: "auth_type",
      message:
        'secret env values live in the connector credential; set auth_type "header" and store one credential entry per name in env_secret_names',
    };
  }
  return null;
}

export function localConnectorIssue(
  shape: LocalConnectorShape,
  prior?: { config: unknown } | null,
): LocalConnectorIssue | null {
  if (shape.driver === "mcp") {
    const stdio = isStdioMcpConfig(shape.config);
    if (prior && isStdioMcpConfig(prior.config) !== stdio) {
      return {
        path: "config.mcp.transport",
        message:
          "an MCP connector cannot switch between a local command (stdio) and an address; create a new connector instead",
      };
    }
    if (stdio) return stdioIssue(shape);
    const tls = record(record(shape.config)?.mcp)?.tls;
    if (tls !== undefined && !connectorTargetIsLocal(shape)) {
      return {
        path: "config.mcp.tls",
        message:
          "tls (own CA or skipping verification) applies to local addresses only — localhost, 127.0.0.1, ::1 or host.docker.internal; a remote server must present a publicly trusted certificate",
      };
    }
    return null;
  }
  const tls = record(shape.config)?.tls;
  if (tls !== undefined && !connectorTargetIsLocal(shape)) {
    return {
      path: "config.tls",
      message: TLS_LOCAL_ONLY,
    };
  }
  return null;
}
