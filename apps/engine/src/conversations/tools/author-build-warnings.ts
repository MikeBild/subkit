import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { classifyRequestStepSideEffects } from "../../execution/steps/request/side-effects.ts";
import { type ConnectorAccessLevel, connectorAccessLevel } from "../../rbac/evaluator.ts";
import {
  GRAPHQL_OVER_HTTP_LOSS,
  GRAPHQL_OVER_HTTP_REPAIR,
  introducedGraphqlOverHttpSteps,
} from "../../workflows/graphql-conversion.ts";
import type { RequestStep } from "../../workflows/types.ts";

export interface BuildWarning {
  step_key: string | null;
  code: string;
  message: string;
}

type StepsHolder = Parameters<typeof introducedGraphqlOverHttpSteps>[0];

export function graphqlOverHttpWarnings(before: StepsHolder, after: StepsHolder): BuildWarning[] {
  return introducedGraphqlOverHttpSteps(before, after).map((stepKey) => ({
    step_key: stepKey,
    code: "graphql_over_http",
    message: `step ${stepKey} POSTs a GraphQL document over plain HTTP: ${GRAPHQL_OVER_HTTP_LOSS}. ${GRAPHQL_OVER_HTTP_REPAIR}`,
  }));
}

export async function authorConnectorWriteWarnings(
  db: Db,
  author: ResolvedPrincipal,
  tenantId: string,
  steps: ReadonlyArray<Record<string, unknown>>,
): Promise<BuildWarning[]> {
  const warnings: BuildWarning[] = [];
  const levelCache = new Map<string, ConnectorAccessLevel>();

  for (const step of steps) {
    if (step.kind !== "request") continue;
    const connectorId = typeof step.connector_id === "string" ? step.connector_id : null;
    if (!connectorId) continue;
    if (classifyRequestStepSideEffects(step as unknown as RequestStep) !== "write") continue;

    let level = levelCache.get(connectorId);
    if (level === undefined) {
      level = await connectorAccessLevel(db, author, connectorId, tenantId);
      levelCache.set(connectorId, level);
    }
    if (level === "read-write") continue;

    const stepKey = typeof step.id === "string" ? step.id : null;
    const have = level === "read-only" ? "read-only" : "no";
    warnings.push({
      step_key: stepKey,
      code: "author_missing_permission",
      message:
        `you have ${have} access to connector ${connectorId}; step ` +
        `${stepKey ?? "?"} performs a write that needs read-write — request a grant ` +
        `or a key with that access before running this workflow`,
    });
  }
  return warnings;
}
