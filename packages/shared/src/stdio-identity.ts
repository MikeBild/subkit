export const STDIO_IDENTITY_PREFIX = "stdio:";

const STDIO_IDENTITY_RE = /^stdio:[0-9a-f]{64}$/;

export function isStdioIdentity(value: string): boolean {
  return STDIO_IDENTITY_RE.test(value);
}

export interface StdioCommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  env_secret_names: string[];
  cwd?: string;
}

export interface StdioConfirmation {
  confirmed_command_hash?: string;
  confirmed_by?: string;
  confirmed_at?: string;
  command_set_by?: string;
}

export const STDIO_SERVER_MANAGED_FIELDS = [
  "confirmed_command_hash",
  "confirmed_by",
  "confirmed_at",
  "command_set_by",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mcpConfigBlockOf(config: unknown): Record<string, unknown> | null {
  if (!isRecord(config)) return null;
  return isRecord(config.mcp) ? config.mcp : null;
}

export function isStdioMcpConfig(config: unknown): boolean {
  return mcpConfigBlockOf(config)?.transport === "stdio";
}

export function stdioSpecFromConfig(config: unknown): StdioCommandSpec | null {
  const block = mcpConfigBlockOf(config);
  if (block?.transport !== "stdio" || typeof block.command !== "string") return null;
  const args = Array.isArray(block.args)
    ? block.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const env: Record<string, string> = {};
  if (isRecord(block.env)) {
    for (const [name, value] of Object.entries(block.env)) {
      if (typeof value === "string") env[name] = value;
    }
  }
  const env_secret_names = Array.isArray(block.env_secret_names)
    ? block.env_secret_names.filter((name): name is string => typeof name === "string")
    : [];
  return {
    command: block.command,
    args,
    env,
    env_secret_names,
    ...(typeof block.cwd === "string" && block.cwd.length > 0 ? { cwd: block.cwd } : {}),
  };
}

export function stdioConfirmationFromConfig(config: unknown): StdioConfirmation {
  const block = mcpConfigBlockOf(config);
  const out: StdioConfirmation = {};
  if (!block) return out;
  for (const field of STDIO_SERVER_MANAGED_FIELDS) {
    const value = block[field];
    if (typeof value === "string" && value.length > 0) out[field] = value;
  }
  return out;
}

export function withoutStdioServerManagedFields(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const block = mcpConfigBlockOf(config);
  if (!config || !block) return config;
  if (!STDIO_SERVER_MANAGED_FIELDS.some((field) => Object.hasOwn(block, field))) return config;
  const cleaned = { ...block };
  for (const field of STDIO_SERVER_MANAGED_FIELDS) delete cleaned[field];
  return { ...config, mcp: cleaned };
}
