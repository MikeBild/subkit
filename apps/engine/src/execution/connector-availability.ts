import type { ConnectorView } from "../connectors/types.ts";
import type { CredentialAuthorityMetadata } from "../credentials/authority-metadata.ts";
import type { RequestStep } from "../workflows/types.ts";
import type { RefusedConnector } from "./state.ts";
import { classifyRequestStepSideEffects } from "./steps/request/side-effects.ts";
import type { StepErrorDetail } from "./types.ts";

export type ConnectorUnavailability =
  | "missing"
  | FoundConnectorUnavailability
  | "too_many_references";

export type FoundConnectorUnavailability = "disabled" | "needs_reauth" | "credential_unavailable";

export function connectorUnavailability(
  connector: { enabled: boolean; needs_reauth: boolean },
  credential: Pick<CredentialAuthorityMetadata, "available"> | null | undefined,
  credentialRequired: boolean,
): FoundConnectorUnavailability | null {
  if (!connector.enabled) return "disabled";
  if (connector.needs_reauth) return "needs_reauth";
  if (credentialRequired && !credential?.available) return "credential_unavailable";
  return null;
}

export interface PreparedReferenceRefusal {
  step_id: string | null;
  connector_id: string | null;
  connector_slug: string | null;
  connector_name: string | null;
  environment: "dev" | "prod";
  reason: ConnectorUnavailability;
}

export function preparedReferenceRefusalMessage(refusal: PreparedReferenceRefusal): string {
  const name = `Connector "${refusal.connector_slug ?? refusal.connector_id ?? "unknown"}" in ${refusal.environment}`;
  switch (refusal.reason) {
    case "missing":
      return `${name} does not exist; add it before this workflow can run.`;
    case "disabled":
      return `${name} is disabled; enable it before this workflow can run.`;
    case "needs_reauth":
      return `${name} must be reconnected before this workflow can run.`;
    case "credential_unavailable":
      return `${name} has no usable credential; connect it before this workflow can run.`;
    case "too_many_references":
      return "This workflow references more connectors than one run can prepare.";
  }
}

export const CONNECTOR_DISABLED_CODE = "connector_disabled";

export function disabledConnectorRefusal(
  connector: Pick<
    ConnectorView,
    "id" | "slug" | "display_name" | "environment" | "enabled" | "base_url"
  >,
  step_id: string | null,
): StepErrorDetail | null {
  if (connector.enabled) return null;
  const details: PreparedReferenceRefusal = {
    step_id,
    connector_id: connector.id,
    connector_slug: connector.slug,
    connector_name: connector.display_name,
    environment: connector.environment,
    reason: "disabled",
  };
  return {
    code: CONNECTOR_DISABLED_CODE,
    message: preparedReferenceRefusalMessage(details),
    details,
  };
}

export const CONNECTOR_ENVIRONMENT_MISMATCH_CODE = "connector_environment_mismatch";

export function environmentMismatchRefusal(
  connector: Pick<ConnectorView, "slug" | "environment" | "base_url">,
  step: RequestStep,
  execution_mode: "dev" | "prod",
): StepErrorDetail | null {
  if (connector.environment === execution_mode) return null;
  if (classifyRequestStepSideEffects(step, undefined, undefined, connector.base_url) !== "write")
    return null;
  return {
    code: CONNECTOR_ENVIRONMENT_MISMATCH_CODE,
    message:
      `write step requested environment "${execution_mode}" but connector "${connector.slug}" only resolves to "${connector.environment}" — ` +
      `create a ${execution_mode} binding for this connector; an author label is not permission to send writes through an environment fallback`,
  };
}

export function connectorStepRefusal(
  connector: Pick<
    ConnectorView,
    "id" | "slug" | "display_name" | "environment" | "enabled" | "base_url"
  >,
  step: RequestStep,
  execution_mode: "dev" | "prod",
): StepErrorDetail | null {
  return (
    environmentMismatchRefusal(connector, step, execution_mode) ??
    disabledConnectorRefusal(connector, step.id)
  );
}

export function refusedConnectorOf(error: {
  code: string;
  details?: unknown;
}): RefusedConnector | null {
  if (error.code !== CONNECTOR_DISABLED_CODE) return null;
  const named = (error.details ?? {}) as { connector_id?: unknown; reason?: unknown };
  if (typeof named.reason !== "string") return null;
  return {
    connector_id: typeof named.connector_id === "string" ? named.connector_id : null,
    reason: named.reason,
  };
}
