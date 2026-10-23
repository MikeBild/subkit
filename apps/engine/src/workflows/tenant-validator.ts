import type { GraphqlConnectorTarget } from "../connectors/drivers/graphql-endpoint.ts";
import {
  type ConnectorHeaderPolicy,
  connectorHeaderPolicy,
  loadConnectorSystem,
} from "../connectors/index.ts";
import type { Executor } from "../db/client.ts";
import type { ConnectorBaseUrls } from "./graphql-conversion.ts";
import { WorkflowDefSchema } from "./types.ts";
import { type ValidateOptions, validateWorkflowDef } from "./validator.ts";

export async function loadTenantWorkflowHeaderPolicies(
  input: unknown,
  tenantId: string,
  db: Executor,
): Promise<ReadonlyMap<string, ConnectorHeaderPolicy>> {
  const parsed = WorkflowDefSchema.safeParse(input);
  if (!parsed.success) return new Map();
  const ids = new Set<string>();
  for (const step of parsed.data.steps) {
    if (
      step.kind === "request" &&
      step.connector_id &&
      step.headers &&
      Object.keys(step.headers).length > 0
    )
      ids.add(step.connector_id);
  }
  const policies = new Map<string, ConnectorHeaderPolicy>();
  for (const id of ids) {
    let merged: ConnectorHeaderPolicy | undefined;
    for (const environment of ["dev", "prod"] as const) {
      const system = await loadConnectorSystem(tenantId, id, environment, db);
      if (!system) continue;
      const credential = ["header", "query"].includes(system.connector.auth_type)
        ? await system.getCredentials()
        : null;
      const policy = connectorHeaderPolicy(system.connector, credential?.value ?? null);
      merged = {
        allowAuthorization: policy.allowAuthorization && (merged?.allowAuthorization ?? true),
        ownedHeaders: new Set([...(merged?.ownedHeaders ?? []), ...policy.ownedHeaders]),
      };
    }
    if (merged) policies.set(id, merged);
  }
  return policies;
}

export async function loadTenantWorkflowGraphqlTargets(
  input: unknown,
  tenantId: string,
  db: Executor,
): Promise<ReadonlyMap<string, ReadonlyArray<GraphqlConnectorTarget>>> {
  const parsed = WorkflowDefSchema.safeParse(input);
  if (!parsed.success) return new Map();
  const ids = new Set(
    parsed.data.steps.flatMap((step) =>
      step.kind === "request" && step.graphql && step.connector_id ? [step.connector_id] : [],
    ),
  );
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      const systems = await Promise.all(
        (["dev", "prod"] as const).map((environment) =>
          loadConnectorSystem(tenantId, id, environment, db),
        ),
      );
      return [
        id,
        systems.flatMap((system) =>
          system
            ? [
                {
                  driver: system.driver,
                  base_url: system.connector.base_url ?? null,
                  auth_type: system.connector.auth_type,
                },
              ]
            : [],
        ),
      ] as const;
    }),
  );
  return new Map(entries.filter(([, drivers]) => drivers.length > 0));
}

export async function loadTenantConnectorBaseUrls(
  connectorIds: Iterable<string>,
  tenantId: string,
  db: Executor,
): Promise<ConnectorBaseUrls> {
  const entries = await Promise.all(
    [...new Set(connectorIds)].map(async (id) => {
      const systems = await Promise.all(
        (["dev", "prod"] as const).map((environment) =>
          loadConnectorSystem(tenantId, id, environment, db),
        ),
      );
      return [
        id,
        [...new Set(systems.flatMap((system) => system?.connector.base_url ?? []))],
      ] as const;
    }),
  );
  return new Map(entries.filter(([, baseUrls]) => baseUrls.length > 0));
}

function readLabelledPostConnectorIds(input: unknown): string[] {
  const parsed = WorkflowDefSchema.safeParse(input);
  if (!parsed.success) return [];
  return parsed.data.steps.flatMap((step) =>
    step.kind === "request" &&
    step.connector_id &&
    step.side_effects === "read" &&
    step.method?.toUpperCase() === "POST" &&
    !step.graphql &&
    !step.sql &&
    !step.mcp &&
    !step.s3 &&
    !/^https?:\/\//i.test(step.url ?? "")
      ? [step.connector_id]
      : [],
  );
}

export async function validateTenantWorkflowDef(
  input: unknown,
  tenantId: string,
  db: Executor,
  options: Pick<ValidateOptions, "allowForwardRefs" | "destinationTier" | "lintJavascript"> = {},
) {
  const [policies, graphqlTargets, baseUrls] = await Promise.all([
    loadTenantWorkflowHeaderPolicies(input, tenantId, db),
    loadTenantWorkflowGraphqlTargets(input, tenantId, db),
    loadTenantConnectorBaseUrls(readLabelledPostConnectorIds(input), tenantId, db),
  ]);
  return validateWorkflowDef(input, {
    ...options,
    connectorHeaderPolicies: policies,
    connectorGraphqlTargets: graphqlTargets,
    connectorBaseUrls: baseUrls,
  });
}

export function validateTenantWorkflowDefForSave(
  input: unknown,
  tenantId: string,
  db: Executor,
  options: Pick<ValidateOptions, "destinationTier"> = {},
) {
  return validateTenantWorkflowDef(input, tenantId, db, { ...options, lintJavascript: true });
}
