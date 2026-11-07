import { UNDESCRIBED_METADATA } from "../../api/catalog-metadata.ts";
import type { McpClientLike } from "../../mcp/client/pool.ts";
import type { ConnectorView } from "../types.ts";

export const CONNECT_FAILURES = new Map<string, string>();

export const PROBE_TOOLS = [
  { name: "search", description: "search", inputSchema: { type: "object" } },
  { name: "fetch", description: "fetch", inputSchema: { type: "object" } },
];

export function makeProbeClient(url: string): McpClientLike {
  return {
    async connect() {
      const failure = CONNECT_FAILURES.get(new URL(url).host);
      if (failure !== undefined) throw new Error(failure);
    },
    async listTools() {
      return { tools: PROBE_TOOLS };
    },
    getInstructions() {
      return "use search first";
    },
    async callTool() {
      return { content: [], isError: false };
    },
    async readResource() {
      return { contents: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async close() {},
  };
}

export function mcpConnectorView(p: {
  tenant_id: string;
  id: string;
  slug: string;
  base_url: string | null;
  config?: Record<string, unknown>;
  auth_type?: ConnectorView["auth_type"];
}): ConnectorView {
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    slug: p.slug,
    display_name: p.slug,
    ...UNDESCRIBED_METADATA,
    driver: "mcp",
    environment: "prod",
    auth_type: p.auth_type ?? "none",
    base_url: p.base_url,
    dsn: null,
    config: p.config ?? { mcp: { transport: "http" } },
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: new Date(0),
    updated_at: new Date(0),
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300_000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
  };
}

export function captureNdjsonLogs(): { records: Record<string, unknown>[]; restore: () => void } {
  const records: Record<string, unknown>[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {}
    }
    return true;
  }) as typeof process.stdout.write;
  return {
    records,
    restore: () => {
      process.stdout.write = orig as typeof process.stdout.write;
    },
  };
}
