import { errorFields, logger } from "../../../logging/index.ts";
import {
  createdByWorkflowVariables,
  createdResourceKey,
  deleteOutcome,
  OWNED_DELETE_DENIAL_MESSAGE,
  ownedDeleteCollection,
  ownedResourceKeysOf,
  type RequestBoundary,
  recordsCreatedEndpoint,
} from "../../../workflows/index.ts";
import {
  claimOwnedDelete,
  type OwnedResourceCorrelation,
  recordCreatedResources,
  settleOwnedDelete,
} from "../../persistence/owned-resources.ts";
import { resolveValuePath } from "../../selectors.ts";
import { GOVERNANCE_REFUSALS } from "../../state.ts";
import type { StepResult } from "../../types.ts";
import { failedStep, type RequestDispatch, type RunRequestStepParams } from "./drivers/context.ts";

export interface OwnedDeleteClaim {
  correlation: OwnedResourceCorrelation;
  resource_keys: string[];
}

function correlationOf(
  p: RunRequestStepParams,
  connectorId: string,
  collectionPath: string,
): OwnedResourceCorrelation {
  return {
    collection_path: collectionPath,
    tenant_id: p.ctx.tenant_id,
    workflow_id: p.ctx.workflow_id,
    workflow_version_id: p.ctx.workflow_version_id,
    environment: p.ctx.execution_mode,
    connector_id: connectorId,
    execution_id: p.ctx.execution_id,
    step_id: p.step.id,
  };
}

function denied(d: RequestDispatch, code: string, detail: string): { result: StepResult } {
  return {
    result: failedStep(d, {
      code,
      message:
        `This removal is refused by the ownership ledger: ${detail}. Nothing was sent. ` +
        "A DELETE under `{created_by_workflow: true}` may remove only an id an earlier step of this workflow recorded with `records_created`, once.",
    }),
  };
}

export async function claimDeclaredOwnedDelete(
  d: RequestDispatch,
  declared: RequestBoundary | null,
  url: string,
): Promise<{ result: StepResult } | { claim: OwnedDeleteClaim } | null> {
  const { p } = d;
  if (!p.step.boundary || createdByWorkflowVariables(p.step.boundary).length === 0) return null;
  const collection = ownedDeleteCollection(p.step.boundary, p.step);
  if (!declared || !p.step.connector_id || collection === null)
    return denied(
      d,
      "delete_target_not_created_by_workflow",
      OWNED_DELETE_DENIAL_MESSAGE.delete_target_not_created_by_workflow,
    );
  const correlation = correlationOf(p, p.step.connector_id, collection);
  const resource_keys = ownedResourceKeysOf(declared, new URL(url));
  const decision = await claimOwnedDelete(p.ctx.db, correlation, {
    method: p.step.method ?? "GET",
    destructive: declared.destructive === true,
    resource_keys,
  });
  if (!decision.allow) return denied(d, decision.code, OWNED_DELETE_DENIAL_MESSAGE[decision.code]);
  return { claim: { correlation, resource_keys } };
}

export async function settleClaimedOwnedDelete(
  claim: OwnedDeleteClaim,
  db: RunRequestStepParams["ctx"]["db"],
  result: StepResult,
): Promise<void> {
  const outcome = deleteOutcome(result, GOVERNANCE_REFUSALS);
  try {
    await settleOwnedDelete(db, claim.correlation, claim.resource_keys, outcome);
  } catch (err) {
    logger.error({
      module: "execution",
      action: "owned_resource.settle_failed",
      msg: "removal outcome could not be settled; the id stays reserved and is never removed again without inspection",
      execution_id: claim.correlation.execution_id,
      step_id: claim.correlation.step_id,
      outcome,
      ...errorFields(err),
    });
  }
}

export async function recordStepCreatedResources(
  p: RunRequestStepParams,
  result: StepResult,
): Promise<StepResult> {
  const endpoint = "records_created" in p.step ? recordsCreatedEndpoint(p.step) : null;
  if (
    !endpoint ||
    !p.step.connector_id ||
    result.status !== "succeeded" ||
    result.held ||
    p.ctx.hold_writes
  )
    return result;
  const extracted = createdResourceKey(
    resolveValuePath(result.output, endpoint.id_path),
    endpoint.id_path,
  );
  const failure = (message: string): StepResult => ({
    ...result,
    status: "failed",
    error: {
      code: "created_resource_unrecorded",
      message: `The request succeeded, but the created id was not recorded: ${message}. A later removal of it will be refused; correct \`records_created.id_path\`.`,
    },
  });
  if ("invalid" in extracted) return failure(extracted.invalid);
  try {
    await recordCreatedResources(
      p.ctx.db,
      correlationOf(p, p.step.connector_id, endpoint.collection_path),
      [extracted.key],
    );
    return result;
  } catch (err) {
    logger.error({
      module: "execution",
      action: "owned_resource.record_failed",
      msg: "created ids could not be recorded in the ownership ledger",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      ...errorFields(err),
    });
    return failure("the ownership ledger could not be written");
  }
}
