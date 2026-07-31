// What this config still says that this engine no longer has.
//
// Separated from the loader because it is a MIGRATION question, not a loading
// one: the loader's job is to merge sources and validate a shape, while this
// module answers "does the file on disk describe a world that ended?". Keeping
// the two apart matters because this check is temporary by nature — a retired
// section eventually stops being worth naming — and a concern with an expiry
// date should not be woven through the code that outlives it.
//
// It reports rather than throws. The loader owns `ConfigLoaderError` and the
// decision to stop; importing that back into here would close a cycle for no
// gain. This module knows only what is wrong, and how to say it.

import { ConnectorsMcpSection } from "./schema.ts";

export interface RetiredSectionReport {
  /** Paths that still carry a decision someone made — booting must stop. */
  offenders: string[];
  /** Paths that were present but held nothing — dropped, worth one warning. */
  dropped: string[];
}

/** The `connectors.mcp.*` budgets with nothing configured — the values a
 *  leftover `mcp.client` has to differ from before it is worth stopping over.
 *  Read from the schema rather than restated, so the check cannot drift when
 *  one of those defaults changes. */
const MCP_BUDGET_DEFAULTS: Record<string, unknown> = ConnectorsMcpSection.parse({});

/** Does this leftover `mcp.client` block still carry an operator's decision?
 *  Only keys that exist AND differ from what the new section already defaults
 *  to. A block that repeats the defaults says nothing the engine would not do
 *  anyway. Unknown keys count: a value this engine cannot interpret is exactly
 *  the case where guessing is wrong. */
function clientOverrides(client: unknown): string[] {
  if (client === undefined || client === null) return [];
  if (typeof client !== "object" || Array.isArray(client)) return ["mcp.client"];
  return Object.entries(client as Record<string, unknown>)
    .filter(([key, value]) => !(key in MCP_BUDGET_DEFAULTS) || value !== MCP_BUDGET_DEFAULTS[key])
    .map(([key]) => key);
}

/**
 * Find the retired MCP sections a config still declares, split by whether
 * anything is at stake.
 *
 * WHY A POPULATED SECTION MUST STOP THE BOOT. `ConfigSchema` is a plain
 * `z.object`, so an unknown key is STRIPPED at parse time with no error and no
 * log. That alone would be quiet enough to be wrong; what makes it destructive
 * is `setConfigKey`, which reserializes the whole parsed config back to disk —
 * so the first settings write after an upgrade would DELETE the operator's
 * server declarations. A retired env var can warn and continue because nothing
 * is lost; that is data, and only a refusal is honest.
 *
 * WHY AN EMPTY ONE MUST NOT. The argument above is about data, so it reaches
 * exactly as far as the data does. An empty `servers` array, and an `mcp.client`
 * that only repeats the new defaults, hold no decision — there is nothing for a
 * later write to erase. Stopping there protected nothing and cost a production
 * deploy: the engine refused five times over a message that itself printed
 * "(0 declaration(s))", and the rollback that followed took the service down.
 */
export function inspectRetiredMcpSections(merged: Record<string, unknown>): RetiredSectionReport {
  const offenders: string[] = [];
  const dropped: string[] = [];
  const declaredServers = (s: Record<string, unknown> | undefined): number | null =>
    Array.isArray(s?.servers) ? (s.servers as unknown[]).length : null;

  const note = (path: string, count: number | null, keys: string[]): void => {
    // `servers` is counted, `client` is keyed — either way the question is the
    // same: is there anything here a human decided?
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

/** The refusal an operator reads. It carries the migration, not just the
 *  complaint — this message is the only instruction most upgraders will get. */
export function retiredSectionMessage(configPath: string, offenders: readonly string[]): string {
  return [
    `${configPath} declares configuration this engine no longer has:`,
    ...offenders.map((o) => `  - ${o}`),
    "",
    "An external MCP server is now a connector whose driver is `mcp`. Recreate each",
    "declared server as a connector (`sk connectors create --file`), with:",
    '  driver: "mcp", environment: "prod", base_url: <the server url>,',
    '  config: { mcp: { transport: "http", auth: { kind: … } } }',
    "and attach its secret with `sk credentials` — config never carries one.",
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
