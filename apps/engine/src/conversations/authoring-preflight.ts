import { AsyncLocalStorage } from "node:async_hooks";
import { scoreEndpoints } from "../connectors/discovery/endpoint-scorer.ts";
import {
  isUsefulDiscovery,
  readDiscoveryIndexForConnector,
} from "../connectors/discovery/service.ts";
import type { DiscoveredEndpoint, DiscoveryResult } from "../connectors/discovery/types.ts";
import { logger } from "../logging/index.ts";
import { listLatestShapes } from "../schema-versions/index.ts";
import type { GroundedConnector } from "./authoring-grounding.ts";
import { discoverConnectorEndpointsTool } from "./tools/discover-connector-endpoints.ts";
import type { ToolContext } from "./tools/index.ts";
import { checkToolPermission } from "./tools/permission-gate.ts";
import { probeConnectorTool } from "./tools/probe-connector.ts";

export const PREFLIGHT_BUDGET_MS = 20_000;
const PREFLIGHT_PROBES_PER_CONNECTOR = 2;
const PREFLIGHT_PROBE_TIMEOUT_MS = 8_000;
const RECORDED_SHAPE_LOOKUP_LIMIT = 50;

export interface ConnectorPreflightArgs {
  ctx: ToolContext;
  goal: string;
  connector: GroundedConnector;
  signal: AbortSignal;
}

type ConnectorPreflight = (args: ConnectorPreflightArgs) => Promise<DiscoveryResult | null>;

const preflightOverride = new AsyncLocalStorage<ConnectorPreflight>();

export function _withConnectorPreflightForTests<T>(
  preflight: ConnectorPreflight,
  body: () => Promise<T>,
): Promise<T> {
  return preflightOverride.run(preflight, body);
}

export function activeConnectorPreflight(): ConnectorPreflight {
  return preflightOverride.getStore() ?? preflightConnector;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(fallback);
      },
    );
  });
}

export async function runConnectorPreflights(args: {
  ctx: ToolContext;
  goal: string;
  connectors: GroundedConnector[];
  signal: AbortSignal;
  preflight: ConnectorPreflight;
}): Promise<Map<string, DiscoveryResult>> {
  const { ctx, goal, connectors, signal, preflight } = args;
  const out = new Map<string, DiscoveryResult>();
  await Promise.all(
    connectors.map(async (connector) => {
      const work = preflight({ ctx, goal, connector, signal }).catch((err: unknown) => {
        skip(ctx, connector, "preflight", err instanceof Error ? err.message : String(err));
        return null;
      });
      const index = await untilAborted(work, signal, null);
      if (index && index.endpoints.length > 0) out.set(connector.id, index);
    }),
  );
  if (signal.aborted) {
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.preflight_budget_exhausted",
      msg: "pre-flight discovery stopped at its time budget; generation continues with the evidence gathered so far",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_count: connectors.length,
      indexed_count: out.size,
    });
  }
  return out;
}

function skip(ctx: ToolContext, connector: GroundedConnector, stage: string, reason: string) {
  logger.info({
    module: "conversations",
    action: "authoring_pipeline.preflight_skipped",
    msg: "pre-flight step skipped; generation continues without it",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    connector_id: connector.id,
    stage,
    reason,
  });
}

function errorCodeOf(data: unknown): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.error_code === "string") return record.error_code;
    const error = record.error as Record<string, unknown> | undefined;
    if (error && typeof error.code === "string") return error.code;
  }
  return "unknown";
}

async function ensureDiscoveryIndex(
  scoped: ToolContext,
  connector: GroundedConnector,
): Promise<DiscoveryResult | null> {
  const cached = await readDiscoveryIndexForConnector(scoped.db, scoped.tenant_id, connector);
  if (cached) return cached;
  const discovered = await discoverConnectorEndpointsTool.execute(scoped, {
    connector_id: connector.id,
  });
  if (!discovered.ok) {
    skip(scoped, connector, "discover", errorCodeOf(discovered.data));
    return null;
  }
  const result = (discovered.data as { result?: DiscoveryResult } | undefined)?.result;
  if (!result || !isUsefulDiscovery(result)) {
    skip(scoped, connector, "discover", "no_endpoints");
    return null;
  }
  return result;
}

export function probeableGoalEndpoints(
  goal: string,
  endpoints: readonly DiscoveredEndpoint[],
  limit: number,
): DiscoveredEndpoint[] {
  const readable = endpoints.filter(
    (e) =>
      e.method === "GET" &&
      !e.deprecated &&
      !e.path.includes("{") &&
      !e.params.some((p) => p.required && p.in !== "header"),
  );
  return scoreEndpoints(goal, readable, limit)
    .filter((s) => s.score > 0)
    .map((s) => s.endpoint);
}

async function recordGoalShapes(
  scoped: ToolContext,
  goal: string,
  connector: GroundedConnector,
  index: DiscoveryResult,
): Promise<void> {
  if (connector.driver !== "http") return;
  const candidates = probeableGoalEndpoints(goal, index.endpoints, PREFLIGHT_PROBES_PER_CONNECTOR);
  if (candidates.length === 0) return;
  const recorded = new Set(
    (
      await listLatestShapes(
        {
          tenant_id: scoped.tenant_id,
          connector_id: connector.id,
          max_endpoints: RECORDED_SHAPE_LOOKUP_LIMIT,
        },
        scoped.db,
      )
    ).map((s) => s.endpoint_key),
  );
  for (const endpoint of candidates) {
    if (scoped.abortSignal?.aborted) return;
    if (recorded.has(`GET ${endpoint.path}`)) continue;
    const probeArgs: Record<string, unknown> = {
      connector_slug: connector.slug,
      method: "GET",
      path: endpoint.path,
      response_mode: "shape",
      timeout_ms: PREFLIGHT_PROBE_TIMEOUT_MS,
      ...(connector.environment ? { environment: connector.environment } : {}),
    };
    if (probeConnectorTool.permission) {
      const permitted = await checkToolPermission(scoped, probeConnectorTool.permission, probeArgs);
      if (!permitted.allow) {
        skip(scoped, connector, "probe", permitted.reason);
        return;
      }
    }
    const probed = await probeConnectorTool.execute(scoped, probeArgs);
    if (!probed.ok) {
      skip(scoped, connector, "probe", errorCodeOf(probed.data));
      return;
    }
  }
}

export const preflightConnector: ConnectorPreflight = async ({ ctx, goal, connector, signal }) => {
  const scoped: ToolContext = { ...ctx, abortSignal: signal };
  const index = await ensureDiscoveryIndex(scoped, connector);
  if (!index) return null;
  try {
    await recordGoalShapes(scoped, goal, connector, index);
  } catch (err) {
    skip(scoped, connector, "probe", err instanceof Error ? err.message : String(err));
  }
  return index;
};
