import { ConnectorsMcpSection } from "./schema.ts";

interface RetiredSectionReport {
  offenders: string[];
  dropped: string[];
}

const MCP_BUDGET_DEFAULTS: Record<string, unknown> = ConnectorsMcpSection.parse({});

function clientOverrides(client: unknown): string[] {
  if (client === undefined || client === null) return [];
  if (typeof client !== "object" || Array.isArray(client)) return ["mcp.client"];
  return Object.entries(client as Record<string, unknown>)
    .filter(([key, value]) => !(key in MCP_BUDGET_DEFAULTS) || value !== MCP_BUDGET_DEFAULTS[key])
    .map(([key]) => key);
}

export function inspectRetiredMcpSections(merged: Record<string, unknown>): RetiredSectionReport {
  const offenders: string[] = [];
  const dropped: string[] = [];
  const declaredServers = (s: Record<string, unknown> | undefined): number | null =>
    Array.isArray(s?.servers) ? (s.servers as unknown[]).length : null;

  const note = (path: string, count: number | null, keys: string[]): void => {
    const populated = count === null ? keys.length > 0 : count > 0;
    if (!populated) {
      dropped.push(path);
      return;
    }
    offenders.push(
      count === null ? `${path} (${keys.join(", ")})` : `${path} (${count} declaration(s))`,
    );
  };

  const mcpSection = merged.mcp as Record<string, unknown> | undefined;
  const rootCount = declaredServers(mcpSection);
  if (rootCount !== null) note("mcp.servers", rootCount, []);
  if (mcpSection?.client !== undefined) {
    note("mcp.client", null, clientOverrides(mcpSection.client));
  }

  const tenants = merged.tenants as Record<string, Record<string, unknown>> | undefined;
  for (const [tenant_id, overlay] of Object.entries(tenants ?? {})) {
    const overlayMcp = overlay?.mcp as Record<string, unknown> | undefined;
    const count = declaredServers(overlayMcp);
    if (count !== null) note(`tenants.${tenant_id}.mcp.servers`, count, []);
    if (overlayMcp?.client !== undefined) {
      note(`tenants.${tenant_id}.mcp.client`, null, clientOverrides(overlayMcp.client));
    }
  }

  return { offenders, dropped };
}

export function retiredSectionMessage(configPath: string, offenders: readonly string[]): string {
  return [
    `${configPath} declares configuration this engine no longer has:`,
    ...offenders.map((o) => `  - ${o}`),
    "",
    "An external MCP server is now a connector whose driver is `mcp`. Recreate each",
    "declared server as a connector (`sk connectors create --file`), with:",
    '  driver: "mcp", environment: "prod", base_url: <the server url>,',
    '  config: { mcp: { transport: "http", auth: { kind: … } } }',
    "and attach its secret with `sk vault` — config never carries one.",
    "",
    "The client-pool budgets moved to `connectors.mcp.*`:",
    "  mcp.client.per_server_manifest_byte_cap → connectors.mcp.per_server_manifest_byte_cap",
    "  mcp.client.remote_tool_call_timeout_ms  → connectors.mcp.remote_tool_call_timeout_ms",
    "  mcp.client.tools_list_max_pages         → connectors.mcp.tools_list_max_pages",
    "",
    "Remove the sections above once migrated. Booting past them is refused rather",
    "than skipped: the schema would strip them silently and the next settings write",
    "would erase them from disk.",
  ].join("\n");
}
