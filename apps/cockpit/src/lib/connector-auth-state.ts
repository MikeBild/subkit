import type { TranslationKey } from "./i18n";

/**
 * A connection states where it stands as a word (§11). The list carries the
 * reconciled health verdict and the credential-rejection flag, which is enough
 * to say "connected" or "expired" but not enough to prove that credentials
 * were ever stored — that stays "not proven yet" until a probe resolves it,
 * rather than being guessed.
 */
export type ConnectorAuthState =
  | "connected"
  | "expired"
  | "credentials_missing"
  | "not_required"
  | "unproven";

export interface ConnectorAuthInput {
  auth_type?: string | null;
  health_state?: string | null;
  needs_reauth?: boolean | null;
  auth_failed_at?: string | null;
}

/** Probe outcome, used to refine the state once the connection was tested. */
export interface ProbeOutcome {
  ok: boolean;
  error_code?: string;
}

const LABELS: Record<ConnectorAuthState, TranslationKey> = {
  connected: "connectors.auth.connected",
  expired: "connectors.auth.expired",
  credentials_missing: "connectors.auth.credentialsMissing",
  not_required: "connectors.auth.notRequired",
  unproven: "connectors.auth.unproven",
};

const HINTS: Record<ConnectorAuthState, TranslationKey> = {
  connected: "connectors.auth.connectedHint",
  expired: "connectors.auth.expiredHint",
  credentials_missing: "connectors.auth.credentialsMissingHint",
  not_required: "connectors.auth.notRequiredHint",
  unproven: "connectors.auth.unprovenHint",
};

export function connectorAuthState(
  connector: ConnectorAuthInput,
  probe?: ProbeOutcome | null,
): ConnectorAuthState {
  if (probe) {
    if (probe.ok) return connector.auth_type === "none" ? "not_required" : "connected";
    if (probe.error_code === "credential_missing") return "credentials_missing";
    if (probe.error_code === "credential_expired" || probe.error_code === "credential_invalid")
      return "expired";
  }
  if (connector.needs_reauth === true || connector.health_state === "needs_reauth")
    return "expired";
  if (connector.auth_type === "none") return "not_required";
  // A credential that was accepted at least once and never rejected since.
  if (connector.health_state === "ok" && !connector.auth_failed_at) return "connected";
  return "unproven";
}

export function authStateLabel(state: ConnectorAuthState): TranslationKey {
  return LABELS[state];
}

export function authStateHint(state: ConnectorAuthState): TranslationKey {
  return HINTS[state];
}

/** Only an expired credential names a renewal path; the rest need no red. */
export function needsRenewal(state: ConnectorAuthState): boolean {
  return state === "expired" || state === "credentials_missing";
}
