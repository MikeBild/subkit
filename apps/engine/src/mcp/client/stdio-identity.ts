import {
  isStdioIdentity,
  isStdioMcpConfig,
  mcpConfigBlockOf,
  STDIO_IDENTITY_PREFIX,
  STDIO_SERVER_MANAGED_FIELDS,
  type StdioCommandSpec,
  type StdioConfirmation,
  stdioConfirmationFromConfig,
  stdioSpecFromConfig,
  withoutStdioServerManagedFields,
} from "@shared/stdio-identity.ts";
import { commandSpecDigest } from "../../crypto/index.ts";

export {
  isStdioIdentity,
  isStdioMcpConfig,
  STDIO_IDENTITY_PREFIX,
  STDIO_SERVER_MANAGED_FIELDS,
  type StdioCommandSpec,
  type StdioConfirmation,
  stdioConfirmationFromConfig,
  stdioSpecFromConfig,
  withoutStdioServerManagedFields,
};

export function stdioCommandHash(spec: StdioCommandSpec): string {
  return commandSpecDigest(spec);
}

export function stdioIdentity(spec: StdioCommandSpec): string {
  return `${STDIO_IDENTITY_PREFIX}${stdioCommandHash(spec)}`;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function stdioCommandLine(spec: StdioCommandSpec): string {
  return [spec.command, ...spec.args].map(quoteArg).join(" ");
}

export interface StdioCommandDisplay {
  command_line: string;
  command: string;
  args: string[];
  env_names: string[];
  env_secret_names: string[];
  cwd: string | null;
  command_hash: string;
}

export function stdioCommandDisplay(spec: StdioCommandSpec): StdioCommandDisplay {
  return {
    command_line: stdioCommandLine(spec),
    command: spec.command,
    args: [...spec.args],
    env_names: Object.keys(spec.env).sort(),
    env_secret_names: [...spec.env_secret_names],
    cwd: spec.cwd ?? null,
    command_hash: stdioCommandHash(spec),
  };
}

export function carryStdioConfirmation(
  prior: unknown,
  next: Record<string, unknown> | undefined,
  actor_id: string | null,
): Record<string, unknown> | undefined {
  const cleaned = withoutStdioServerManagedFields(next);
  const nextSpec = stdioSpecFromConfig(cleaned);
  if (!cleaned || !nextSpec) return cleaned;
  const priorSpec = stdioSpecFromConfig(prior);
  const block = mcpConfigBlockOf(cleaned) ?? {};
  const unchanged =
    priorSpec !== null && stdioCommandHash(priorSpec) === stdioCommandHash(nextSpec);
  if (unchanged) {
    const carried = stdioConfirmationFromConfig(prior);
    return { ...cleaned, mcp: { ...block, ...carried } };
  }
  return { ...cleaned, mcp: { ...block, ...(actor_id ? { command_set_by: actor_id } : {}) } };
}

export function mcpServerIdentityOf(
  connector:
    | { driver?: string; base_url?: string | null; config?: Record<string, unknown> | null }
    | null
    | undefined,
): string | null | undefined {
  if (!connector) return connector;
  const spec = stdioSpecFromConfig(connector.config);
  if (spec) return stdioIdentity(spec);
  return connector.base_url;
}
