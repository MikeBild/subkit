import { getConnectorForEnvironment } from "../connectors/service.ts";
import type { Db, Executor } from "../db/client.ts";
import { pooledToolDescriptors } from "../mcp/client/pool.ts";
import { type McpBoundary, mcpToolDescriptorPin } from "./mcp-boundary.ts";

export type ToolPinDrift = "mcp_tool_changed" | "mcp_tool_unavailable";

interface PinnedToolEffect {
  step_id: string;
  connector_id: string | null;
  environment: "dev" | "prod";
  call_path?: string[] | undefined;
  mcp?: McpBoundary | undefined;
}

export async function reviewedToolDrift(
  db: Executor,
  tenant_id: string,
  connector: { id: string; environment: "dev" | "prod" } | null | undefined,
  boundary: McpBoundary,
  fresh = false,
): Promise<ToolPinDrift | null> {
  if (!connector) return "mcp_tool_unavailable";
  let listed: Awaited<ReturnType<typeof pooledToolDescriptors>>;
  try {
    listed = await pooledToolDescriptors({
      db: db as Db,
      tenant_id,
      connector_id: connector.id,
      environment: connector.environment,
      fresh,
    });
  } catch {
    listed = null;
  }
  const tool = listed?.find((entry) => entry.name === boundary.tool);
  if (!tool) return "mcp_tool_unavailable";
  return mcpToolDescriptorPin(tool).digest === boundary.descriptor.digest
    ? null
    : "mcp_tool_changed";
}

export async function toolPinDrifts(
  db: Executor,
  tenant_id: string,
  effects: readonly PinnedToolEffect[],
): Promise<Array<{ step_id: string; call_path?: string[]; reason: ToolPinDrift }>> {
  const drifts: Array<{ step_id: string; call_path?: string[]; reason: ToolPinDrift }> = [];
  for (const effect of effects) {
    if (!effect.mcp) continue;
    const resolved = effect.connector_id
      ? await getConnectorForEnvironment(tenant_id, effect.connector_id, effect.environment, db)
      : null;
    const reason = await reviewedToolDrift(
      db,
      tenant_id,
      resolved ? { id: resolved.id, environment: resolved.environment } : null,
      effect.mcp,
      true,
    );
    if (reason)
      drifts.push({
        step_id: effect.step_id,
        ...(effect.call_path ? { call_path: effect.call_path } : {}),
        reason,
      });
  }
  return drifts;
}

const DRIFT_MESSAGE: Record<ToolPinDrift, string> = {
  mcp_tool_changed:
    "the server describes a tool differently than the step records; update the step and review again",
  mcp_tool_unavailable:
    "a tool this workflow calls could not be found on its server; check the connector and review again",
};

export async function assertToolPinsCurrent(
  db: Executor,
  tenant_id: string,
  effects: readonly PinnedToolEffect[],
): Promise<void> {
  const [first] = await toolPinDrifts(db, tenant_id, effects);
  if (first)
    throw Object.assign(new Error(DRIFT_MESSAGE[first.reason]), {
      code: first.reason,
      details: { step_id: first.step_id },
    });
}

export async function assertPreviewedToolPinsCurrent(
  db: Executor,
  tenant_id: string,
  expected_manifest_digest: string,
  preview: () => Promise<{ digest: string; manifest: { effects: readonly PinnedToolEffect[] } }>,
): Promise<void> {
  const reviewed = await preview();
  if (reviewed.digest !== expected_manifest_digest) return;
  await assertToolPinsCurrent(db, tenant_id, reviewed.manifest.effects);
}
