import { ApiError } from "@/api/client";
import { connectorHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";
import { type Remedy, type RemedyInput, remedyFor } from "@/lib/remedy";

/**
 * Which connector keeps a saved workflow from running in an environment, and
 * why — from the authority preview before a run, and from the run's own 409
 * refusal after it. Both come from the engine's one predicate, so both are
 * said in the same sentence and lead to the same fix.
 */
export type RunEnvironment = "dev" | "prod";

export const RUN_ENVIRONMENTS: readonly RunEnvironment[] = ["dev", "prod"];

export interface UnavailableConnector {
  connector_id: string | null;
  connector_slug: string | null;
  connector_name: string | null;
  /** disabled | needs_reauth | credential_unavailable | missing | too_many_references */
  reason: string;
}

/** The run dialog's pre-check, one per workflow version and environment. */
export function runPreviewKey(workflowId: string, versionId: string, environment: RunEnvironment) {
  return ["workflow-run-preview", workflowId, versionId, environment] as const;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asUnavailable(value: unknown): UnavailableConnector | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const reason = text(entry.reason);
  if (!reason) return null;
  return {
    connector_id: text(entry.connector_id),
    connector_slug: text(entry.connector_slug),
    connector_name: text(entry.connector_name),
    reason,
  };
}

/**
 * The connector a preview says blocks the run, or null. A preview that could
 * not be read, or that names nothing, never blocks: the pre-check is advisory,
 * and the run's refusal remains the authority.
 */
export function blockingConnector(preview: unknown): UnavailableConnector | null {
  if (!preview || typeof preview !== "object") return null;
  const list = (preview as { unavailable_connectors?: unknown }).unavailable_connectors;
  return Array.isArray(list) ? asUnavailable(list[0]) : null;
}

/**
 * A run the engine refused because the running version is stored in an
 * earlier definition format, with the steps it names — or null for any other
 * failure. The refusal carries its reason; "could not be started" would send
 * the reader looking for a fault that is not one.
 */
export function legacyRefusal(error: unknown): { steps: string[] } | null {
  if (!(error instanceof ApiError) || error.code !== "workflow_version_legacy") return null;
  const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
  const steps = issues.flatMap((issue) => {
    const id = (issue as { step_id?: unknown } | null)?.step_id;
    return typeof id === "string" && id ? [id] : [];
  });
  return { steps: [...new Set(steps)] };
}

/**
 * A run the engine refused because no approval admits it — none exists, or
 * the one that exists no longer fits or is used up. Until an approval is
 * given, the same run is refused the same way.
 */
export function approvalRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code ?? "").startsWith("execution_authority_")
  );
}

/** The first environment that can run; development when neither can. */
export function defaultEnvironment(
  blocked: Record<RunEnvironment, UnavailableConnector | null>,
): RunEnvironment {
  return RUN_ENVIRONMENTS.find((environment) => !blocked[environment]) ?? "dev";
}

/** A run refused because a connector cannot serve it — read from the 409's `details`. */
export function refusedConnector(
  error: unknown,
): (UnavailableConnector & { environment: RunEnvironment | null }) | null {
  if (!(error instanceof ApiError) || error.code !== "prepared_credential_unavailable") return null;
  const connector = asUnavailable(error.details);
  if (!connector) return null;
  const environment = error.details?.environment;
  return {
    ...connector,
    environment: environment === "dev" || environment === "prod" ? environment : null,
  };
}

/** The sentence for a blocked environment; null for a reason no sentence names. */
export function blockedSentenceKey(reason: string): TranslationKey | null {
  switch (reason) {
    case "needs_reauth":
      return "run.environment.blocked";
    case "disabled":
      return "run.environment.blockedDisabled";
    case "credential_unavailable":
      return "run.environment.blockedCredential";
    case "missing":
      return "run.environment.blockedMissing";
    default:
      return null;
  }
}

/** The name a person knows the connector by. */
export function connectorLabel(connector: UnavailableConnector): string {
  return connector.connector_name ?? connector.connector_slug ?? "—";
}

/**
 * Where the fix is. A lost or missing sign-in goes through `remedyFor` to the
 * connector's sign-in card; a connector switched off or absent opens the
 * connector itself. Null when the refusal names no connector to open.
 */
export function connectorFix(
  connector: UnavailableConnector,
): Pick<Remedy, "labelKey" | "href"> | null {
  if (!connector.connector_id) return null;
  const authState = refusedSignIn(connector);
  if (authState) {
    const remedy = remedyFor({ authState, canRun: false, canChat: false });
    return remedy ? { labelKey: remedy.labelKey, href: remedy.href } : null;
  }
  return { labelKey: "run.openConnector", href: connectorHref(connector.connector_id) };
}

/**
 * The sign-in a refusal says is gone, as `remedyFor` reads it: a lost or
 * missing credential lands on the connector's sign-in card ("Neu verbinden").
 * Null for a connector switched off or absent — no sign-in fixes those.
 */
export function refusedSignIn(
  connector: Pick<UnavailableConnector, "connector_id" | "reason"> | null | undefined,
): NonNullable<RemedyInput["authState"]> | null {
  if (!connector?.connector_id) return null;
  if (connector.reason !== "needs_reauth" && connector.reason !== "credential_unavailable")
    return null;
  return {
    connectorId: connector.connector_id,
    state: connector.reason === "needs_reauth" ? "expired" : "credentials_missing",
    section: "credentials",
  };
}
