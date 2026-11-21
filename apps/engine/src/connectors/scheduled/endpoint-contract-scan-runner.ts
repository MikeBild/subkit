import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { connectors, workflows, workflowVersions } from "../../db/schema/index.ts";
import { hasPlaceholders } from "../../llm/substitution/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import {
  callConnector,
  flagConnectorAuthFailure,
  flagConnectorContractFailure,
  parseDeprecation,
  setWorkflowHealth,
} from "../index.ts";
import type { AuthType, DriverName } from "../types.ts";

const MAX_OPERATIONS_PER_TENANT = 25;
const PROBE_TIMEOUT_MS = 10_000;

type ProbeQuery = Record<string, string | number | boolean>;

interface GetOperation {
  connector_id: string;
  path: string;
  query?: ProbeQuery;
}

interface CommittedOperation extends GetOperation {
  workflows: Array<{ id: string; slug: string }>;
}

function staticQuery(raw: unknown): ProbeQuery | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const query: ProbeQuery = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      if (hasPlaceholders(value)) return null;
      query[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      query[key] = value;
    } else {
      return null;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function operationKey(op: GetOperation): string {
  const query = op.query
    ? new URLSearchParams(
        Object.entries(op.query)
          .map(([key, value]): [string, string] => [key, String(value)])
          .sort(([a], [b]) => a.localeCompare(b)),
      ).toString()
    : "";
  return `${op.connector_id} ${op.path}?${query}`;
}

function extractGetOperations(dag: unknown): GetOperation[] {
  const out: GetOperation[] = [];
  const steps = (dag as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    if (s.kind !== "request") continue;
    const method = typeof s.method === "string" ? s.method.toUpperCase() : "GET";
    if (method !== "GET") continue;
    if (typeof s.connector_id !== "string" || typeof s.path !== "string") continue;
    if (hasPlaceholders(s.path)) continue;
    const query = staticQuery(s.query);
    if (query === null) continue;
    out.push({ connector_id: s.connector_id, path: s.path, ...(query ? { query } : {}) });
  }
  return out;
}

export async function runEndpointContractScanForTenant(
  tenant_id: string,
  now: Date,
  db: Db,
): Promise<void> {
  const committed = await db
    .select({
      workflow_id: workflows.id,
      workflow_slug: workflows.slug,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        isNotNull(workflows.current_version_id),
      ),
    );

  const ops = new Map<string, CommittedOperation>();
  for (const row of committed) {
    for (const op of extractGetOperations(row.dag)) {
      const key = operationKey(op);
      const existing = ops.get(key);
      if (existing) {
        existing.workflows.push({ id: row.workflow_id, slug: row.workflow_slug });
      } else {
        ops.set(key, {
          ...op,
          workflows: [{ id: row.workflow_id, slug: row.workflow_slug }],
        });
      }
    }
  }

  const healthyConnectors = await db
    .select({
      id: connectors.id,
      slug: connectors.slug,
      driver: connectors.driver,
      auth_type: connectors.auth_type,
      config: connectors.config,
      template_snapshot: connectors.template_snapshot,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.tenant_id, tenant_id),
        isNull(connectors.deleted_at),
        eq(connectors.needs_reauth, false),
        eq(connectors.circuit_state, "closed"),
        eq(connectors.health_state, "ok"),
      ),
    );
  const healthyById = new Map(healthyConnectors.map((c) => [c.id, c]));

  const probeable = [...ops.values()].filter((op) => healthyById.has(op.connector_id));
  const capped = probeable.slice(0, MAX_OPERATIONS_PER_TENANT);
  if (probeable.length > capped.length) {
    logger.info({
      module: "scheduler",
      action: "endpoint_contract_scan.capped",
      msg: "operation list capped — remaining ops probe on later sweeps",
      tenant_id,
      total_operations: probeable.length,
      probed_operations: capped.length,
    });
  }

  logger.info({
    module: "scheduler",
    action: "endpoint_contract_scan.started",
    msg: "proactive endpoint-contract scan started",
    tenant_id,
    workflow_count: committed.length,
    operation_count: capped.length,
  });

  let probed = 0;
  let flagged = 0;

  for (const op of capped) {
    const connectorRef = healthyById.get(op.connector_id);
    if (!connectorRef) continue;
    const connector = { id: connectorRef.id, tenant_id, slug: connectorRef.slug };

    let result: Awaited<ReturnType<typeof callConnector>>;
    try {
      result = await callConnector({
        db,
        tenant_id,
        actor_id: null,
        connector_id: op.connector_id,
        method: "GET",
        path: op.path,
        ...(op.query ? { query: op.query } : {}),
        timeout_ms: PROBE_TIMEOUT_MS,
      });
      probed += 1;
    } catch (err) {
      logger.warn({
        module: "scheduler",
        action: "endpoint_contract_scan.probe_error",
        msg: "contract probe threw — not flagging",
        tenant_id,
        connector_id: op.connector_id,
        path: op.path,
        ...errorFields(err),
      });
      continue;
    }

    if (result.kind !== "ok") continue;

    try {
      if (result.health === "endpoint_gone" || result.health === "deprecated") {
        flagged += 1;
        const severity = result.health === "endpoint_gone" ? "removed" : "deprecated";
        const { transitioned } = await flagConnectorContractFailure(db, connector, {
          error_code: severity === "removed" ? "endpoint_removed" : "endpoint_deprecated",
          deprecation: parseDeprecation(result.headers),
          reason:
            severity === "removed"
              ? `proactive contract probe: GET ${op.path} returned 410 Gone (used by ${op.workflows.map((w) => w.slug).join(", ")})`
              : `proactive contract probe: vendor announced deprecation of GET ${op.path} (used by ${op.workflows.map((w) => w.slug).join(", ")})`,
          workflow_id: op.workflows[0]?.id ?? null,
        });
        if (transitioned) {
          for (const wf of op.workflows) {
            await setWorkflowHealth(
              db,
              { id: wf.id, tenant_id },
              {
                state: "needs_attention",
                reason: `connector ${connector.slug}: GET ${op.path} ${severity === "removed" ? "was removed by the vendor" : "is deprecated by the vendor"}`,
              },
            );
          }
        }
      } else if (result.health === "auth_failed") {
        flagged += 1;
        await flagConnectorAuthFailure(
          db,
          {
            id: connector.id,
            tenant_id,
            slug: connector.slug,
            driver: connectorRef.driver as DriverName,
            auth_type: connectorRef.auth_type as AuthType,
            config: connectorRef.config,
            template_snapshot: connectorRef.template_snapshot ?? null,
          },
          { reason: `proactive contract probe: GET ${op.path} rejected authentication` },
        );
      }
    } catch (err) {
      logger.error({
        module: "scheduler",
        action: "endpoint_contract_scan.flag_failed",
        msg: "failed to roll probe verdict into health — will retry next sweep",
        tenant_id,
        connector_id: op.connector_id,
        ...errorFields(err),
      });
    }
  }

  logger.info({
    module: "scheduler",
    action: "endpoint_contract_scan.completed",
    msg: "proactive endpoint-contract scan completed",
    tenant_id,
    probed,
    flagged,
    duration_ms: Date.now() - now.getTime(),
  });
}
