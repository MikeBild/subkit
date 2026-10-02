import type { ConnectorView } from "../connectors/types.ts";
import type { CredentialAuthorityMetadata } from "../credentials/authority-metadata.ts";
import type { RefusedConnector } from "./state.ts";
import type { StepErrorDetail } from "./types.ts";

/** Why a connector cannot serve a run in its environment. `missing` and
 *  `too_many_references` are decided by the caller that looks the connector
 *  up; the rest are read off a connector it found. */
export type ConnectorUnavailability =
  | "missing"
  | FoundConnectorUnavailability
  | "too_many_references";

/** Why a connector that exists cannot serve. */
export type FoundConnectorUnavailability = "disabled" | "needs_reauth" | "credential_unavailable";

/**
 * The one predicate that decides whether a found connector can serve a run.
 *
 * The run dialog's pre-check (the authority preview) and the admission that
 * refuses the run with 409 both ask this, so the two can never disagree about
 * which connector is in the way or why. `credentialRequired` is the caller's
 * to state: the preview asks it for any connector with an auth type, the
 * admission also for a `{{cred.<slug>}}` placeholder on one without.
 * Metadata only — no token is decrypted and no OAuth exchange started.
 */
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

/** What a refusal names: the step that needs the connector, the connector as
 * resolved in the run's environment, and why it cannot serve. Never a
 * credential field. */
export interface PreparedReferenceRefusal {
  step_id: string | null;
  connector_id: string | null;
  connector_slug: string | null;
  connector_name: string | null;
  environment: "dev" | "prod";
  reason: ConnectorUnavailability;
}

/** One sentence per reason, naming the connector and the environment. */
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

/** The step error code for a connector an operator switched off — the code a
 *  probe of the same connector already answers with. */
export const CONNECTOR_DISABLED_CODE = "connector_disabled";

/**
 * The step error for a resolved connector that is switched off, or `null`
 * when it is not. The request dispatcher and the `for_each` preflight both
 * ask this before they look at the circuit breaker: a disabled connector used
 * to fail its calls until the breaker opened, and the reader was told
 * `circuit_open` about a remote that was never the problem.
 *
 * Only `disabled` refuses here. A connector waiting for a new sign-in still
 * dispatches, because a call that succeeds is what clears that flag again —
 * refusing it would leave the flag with nothing able to lift it.
 *
 * `details` has the shape a prepared-run refusal carries, and `environment`
 * is the connector's own: the twin the run resolved to is the one to enable,
 * not the connector the definition names.
 */
export function disabledConnectorRefusal(
  connector: Pick<ConnectorView, "id" | "slug" | "display_name" | "environment" | "enabled">,
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

/** The connector a step refusal named, for the run's own failure record — so
 *  a reader of the failed run can open the connector that has to be fixed. */
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
