import { ApiError } from "@/api/client";
import { connectorHref } from "@/app/links";
import { authorityIsLive } from "@/lib/automation-state";
import type { TranslationKey } from "@/lib/i18n";
import { type Remedy, type RemedyInput, remedyFor } from "@/lib/remedy";
import type { WorkflowAuthority } from "@/lib/workflow-authorities";

export type RunEnvironment = "dev" | "prod";

export interface UnavailableConnector {
  connector_id: string | null;
  connector_slug: string | null;
  connector_name: string | null;
  reason: string;
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

export function legacyRefusal(error: unknown): { steps: string[] } | null {
  if (!(error instanceof ApiError) || error.code !== "workflow_version_invalid") return null;
  const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
  const steps = issues.flatMap((issue) => {
    const id = (issue as { step_id?: unknown } | null)?.step_id;
    return typeof id === "string" && id ? [id] : [];
  });
  return { steps: [...new Set(steps)] };
}

export function approvalRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code ?? "").startsWith("execution_authority_")
  );
}

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

export function connectorLabel(connector: UnavailableConnector): string {
  return connector.connector_name ?? connector.connector_slug ?? "—";
}

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

export function liveRunEnvironment(
  authorities: readonly WorkflowAuthority[],
  now: number,
): RunEnvironment | null {
  const live = authorities.filter((authority) => authorityIsLive(authority, now));
  if (live.some((authority) => authority.execution_environment === "prod")) return "prod";
  if (live.some((authority) => authority.execution_environment === "dev")) return "dev";
  return null;
}
